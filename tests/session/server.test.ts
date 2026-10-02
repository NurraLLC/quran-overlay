// Real loopback HTTP + WebSocket: owner/viewer capabilities, full state on connect, revisions,
// and the distinct Stop / Pause / Blank effects. No provider credentials are used.
import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import http from 'node:http';
import WebSocket from 'ws';
import type { FastifyInstance } from 'fastify';
import { buildApp } from '../../src/server/app';
import { CommandResolver } from '../../src/server/commands/reducer';
import { Session } from '../../src/server/sessions';
import type { ControlServerMessage, DisplayState, OverlayServerMessage } from '../../src/shared/contracts';
import { Timeline } from '../../src/replay/synth';
import { fullCorpus } from '../helpers';

let app: FastifyInstance;
let session: Session;
let base = '';
let origin = '';
let cookie = '';
const OWNER = 'test-owner-token-0123456789';

beforeAll(async () => {
  const { corpus, ix } = fullCorpus();
  session = new Session({
    corpus,
    ix,
    resolver: new CommandResolver(corpus, null, null),
    decisionClient: null,
    mode: 'deterministic',
    setup: { soniox: false, jev: { provider: null, configured: false, detail: '' }, semantic: () => 'unavailable' },
    overlayUrl: (v) => `${origin}/overlay#view=${v}`,
  });
  const port = 43170 + Math.floor(Math.random() * 500);
  ({ app } = await buildApp({ session, port, ownerToken: OWNER, fetchImpl: (async () => new Response('{}', { status: 500 })) as typeof fetch }));
  await app.listen({ host: '127.0.0.1', port });
  base = `http://127.0.0.1:${port}`;
  origin = base;
  const res = await fetch(`${base}/api/owner/session`, { method: 'POST', headers: { 'content-type': 'application/json', origin }, body: JSON.stringify({ token: OWNER }) });
  cookie = res.headers.get('set-cookie')!.split(';')[0];
});
afterAll(async () => app?.close());

function control() {
  const ws = new WebSocket(`${base.replace('http', 'ws')}/ws/control`, { headers: { origin, cookie } });
  const msgs: ControlServerMessage[] = [];
  ws.on('message', (d) => msgs.push(JSON.parse(String(d))));
  const ready = new Promise<void>((r) => ws.on('open', () => r()));
  return { ws, msgs, ready, send: (m: unknown) => ws.send(JSON.stringify(m)) };
}

function overlay(view: string) {
  const ws = new WebSocket(`${base.replace('http', 'ws')}/ws/overlay`, { headers: { origin } });
  const states: DisplayState[] = [];
  const denied: string[] = [];
  let closeCode = 0;
  ws.on('message', (d) => {
    const m = JSON.parse(String(d)) as OverlayServerMessage;
    if (m.type === 'display') states.push(m.state);
    else if (m.type === 'denied') denied.push(m.reason);
  });
  ws.on('close', (c) => (closeCode = c));
  ws.on('open', () => ws.send(JSON.stringify({ type: 'hello', view, role: 'overlay' })));
  return { ws, states, denied, get closeCode() { return closeCode; } };
}

const until = async (cond: () => boolean, ms = 3000) => {
  const end = Date.now() + ms;
  while (!cond()) {
    if (Date.now() > end) throw new Error('timeout');
    await new Promise((r) => setTimeout(r, 20));
  }
};
const viewToken = () => new URL(session.overlayUrl).hash.split('view=')[1];

describe('local server authorization', () => {
  it('rejects unexpected Host headers and foreign origins', async () => {
    // fetch() silently drops a custom Host header, so use a raw request (DNS-rebinding style).
    const status = await new Promise<number>((resolve) => {
      const u = new URL(`${base}/api/owner/status`);
      http.get({ host: u.hostname, port: u.port, path: u.pathname, headers: { host: 'evil.example' } }, (res) => resolve(res.statusCode ?? 0));
    });
    expect(status).toBe(421);
    const r = await fetch(`${base}/api/owner/session`, { method: 'POST', headers: { 'content-type': 'application/json', origin: 'https://evil.example' }, body: JSON.stringify({ token: OWNER }) });
    expect(r.status).toBe(403);
  });

  it('a wrong owner token gets no cookie; key minting requires the owner cookie and exact origin', async () => {
    const bad = await fetch(`${base}/api/owner/session`, { method: 'POST', headers: { 'content-type': 'application/json', origin }, body: JSON.stringify({ token: 'nope' }) });
    expect(bad.status).toBe(401);
    expect(bad.headers.get('set-cookie')).toBeNull();
    expect((await fetch(`${base}/api/soniox/temporary-key`, { method: 'POST', headers: { origin } })).status).toBe(401);
    expect((await fetch(`${base}/api/soniox/temporary-key`, { method: 'POST', headers: { origin: 'https://evil.example', cookie } })).status).toBe(403);
    // Owner + origin reaches the provider path; with no SONIOX_API_KEY it reports setup, not a key.
    const res = await fetch(`${base}/api/soniox/temporary-key`, { method: 'POST', headers: { origin, cookie } });
    expect(res.status).toBe(503);
    expect(await res.json()).toEqual({ error: 'NOT_CONFIGURED' });
  });

  it('the control socket requires the owner cookie', async () => {
    const ws = new WebSocket(`${base.replace('http', 'ws')}/ws/control`, { headers: { origin } });
    const code = await new Promise<number>((r) => ws.on('close', (c) => r(c)));
    expect(code).toBe(4401);
  });

  it('valid owner links remain usable while failed owner-link guesses are rate limited', async () => {
    const port = 4317;
    const { app: isolated } = await buildApp({ session, port, ownerToken: OWNER });
    const headers = { host: `127.0.0.1:${port}`, origin: `http://127.0.0.1:${port}` };
    const exchange = (token: string) => isolated.inject({ method: 'POST', url: '/api/owner/session', headers, payload: { token } });
    try {
      // Opening multiple real reader/control contexts must not consume the failed-guess budget.
      for (let i = 0; i < 25; i++) expect((await exchange(OWNER)).statusCode).toBe(200);
      for (let i = 0; i < 20; i++) {
        const denied = await exchange('wrong-owner-link');
        expect(denied.statusCode).toBe(401);
        expect(denied.headers['set-cookie']).toBeUndefined();
      }
      const limited = await exchange('wrong-owner-link');
      expect(limited.statusCode).toBe(429);
      expect(limited.headers['set-cookie']).toBeUndefined();
      const allowed = await exchange(OWNER);
      expect(allowed.statusCode).toBe(200);
      const ownerCookie = String(allowed.headers['set-cookie']).split(';')[0];
      const status = await isolated.inject({ method: 'GET', url: '/api/owner/status', headers: { ...headers, cookie: ownerCookie } });
      expect(status.json()).toEqual({ owner: true });
    } finally {
      await isolated.close();
    }
  });

  it('the overlay view capability is read-only: it cannot mint keys or send control messages', async () => {
    const o = overlay(viewToken());
    await until(() => o.states.length > 0);
    o.ws.send(JSON.stringify({ type: 'goto', key: '2:255' }));
    o.ws.send(JSON.stringify({ type: 'hold', on: true }));
    await new Promise((r) => setTimeout(r, 150));
    expect(session.display.verse?.key ?? null).not.toBe('2:255');
    o.ws.close();
  });

  it('an invalid or rotated view token is denied', async () => {
    const bad = overlay('not-the-token-xyz');
    await until(() => bad.denied.length > 0);
    const c = control();
    await c.ready;
    const good = overlay(viewToken());
    await until(() => good.states.length > 0);
    c.send({ type: 'rotate_view' });
    await until(() => good.denied.includes('revoked'));
    c.ws.close();
  });
});

describe('display transport and actions', () => {
  it('a new overlay receives the full latest state immediately; revisions only increase', async () => {
    const c = control();
    await c.ready;
    c.send({ type: 'goto', key: '36:1' });
    await until(() => session.display.verse?.key === '36:1');
    const o = overlay(viewToken());
    await until(() => o.states.length > 0);
    expect(o.states[0].verse?.key).toBe('36:1');
    c.send({ type: 'nav', action: 'next' });
    c.send({ type: 'nav', action: 'next' });
    await until(() => o.states.at(-1)?.verse?.key === '36:3');
    const revs = o.states.map((s) => s.revision);
    expect([...revs].sort((a, b) => a - b)).toEqual(revs);
    expect(new Set(revs).size).toBe(revs.length);
    // Arabic, English and reference arrive together in one state.
    const last = o.states.at(-1)!;
    expect(last.verse).toMatchObject({ key: '36:3', surahName: 'Ya-Sin' });
    expect(last.verse!.english.length).toBeGreaterThan(0);
    o.ws.close();
    c.ws.close();
  });

  it('Stop keeps the verse; Pause freezes it while tracking continues; Blank hides without losing it', async () => {
    const { corpus } = fullCorpus();
    const c = control();
    await c.ready;
    c.send({ type: 'goto', key: '55:10' });
    c.send({ type: 'capture', captureEpoch: 10, event: 'starting' });
    c.send({ type: 'capture', captureEpoch: 10, event: 'recording' });
    const tl = new Timeline();
    for (const k of ['55:10', '55:11', '55:12', '55:13']) tl.reciteVerse(corpus.verse(k)!);
    const results = tl.sorted().filter((e) => e.type === 'result');
    let seq = 0;
    const sendUntil = (key: string) => {
      const cut = tl.truth.findIndex((w) => w.verseKey === key);
      const tEnd = tl.truth[cut + 2]?.endMs ?? Infinity;
      for (const e of results) if (e.type === 'result' && e.t <= tEnd + 800 && e.t > (sendUntil as { last?: number }).last!) c.send({ type: 'transcript', captureEpoch: 10, seq: seq++, tokens: e.tokens, receivedAt: e.t });
      (sendUntil as { last?: number }).last = tEnd + 800;
    };
    (sendUntil as { last?: number }).last = -1;
    sendUntil('55:11');
    await until(() => session.display.verse?.key === '55:11');

    c.send({ type: 'hold', on: true });
    sendUntil('55:12');
    await until(() => session.snapshot().trackerVerse === '55:12');
    expect(session.display.verse?.key).toBe('55:11'); // frozen for the audience
    c.send({ type: 'hold', on: false });
    await until(() => session.display.verse?.key === '55:12'); // resume applies the latest valid match

    c.send({ type: 'blank', on: true });
    await until(() => session.display.visible === false);
    expect(session.display.verse?.key).toBe('55:12');
    c.send({ type: 'blank', on: false });
    await until(() => session.display.visible === true);

    c.send({ type: 'capture', captureEpoch: 10, event: 'stopped' });
    // Late results after Stop never move the display.
    for (const e of results) if (e.type === 'result') c.send({ type: 'transcript', captureEpoch: 10, seq: seq++, tokens: e.tokens, receivedAt: e.t });
    await new Promise((r) => setTimeout(r, 200));
    expect(session.display.verse?.key).toBe('55:12');
    expect(session.snapshot().phase).toBe('stopped');
    c.ws.close();
  });

  it('search results stay private until Show on stream; stale request ids cannot publish', async () => {
    const c = control();
    await c.ready;
    c.send({ type: 'goto', key: '1:1' });
    await until(() => session.display.verse?.key === '1:1');
    c.send({ type: 'command', requestId: 'r1', text: 'no soul is burdened beyond its capacity', source: 'typed' });
    await until(() => c.msgs.some((m) => m.type === 'command_result' && m.requestId === 'r1'));
    const res = c.msgs.find((m) => m.type === 'command_result' && m.requestId === 'r1') as Extract<ControlServerMessage, { type: 'command_result' }>;
    expect(res.result.kind).toBe('candidates');
    expect(session.display.verse?.key).toBe('1:1');
    c.send({ type: 'command', requestId: 'r2', text: 'the one who created death and life', source: 'typed' });
    await until(() => c.msgs.some((m) => m.type === 'command_result' && m.requestId === 'r2'));
    const card = res.result.kind === 'candidates' ? res.result.cards[0].key : '';
    c.send({ type: 'show_result', requestId: 'r1', key: card });
    await new Promise((r) => setTimeout(r, 150));
    expect(session.display.verse?.key).toBe('1:1');
    const r2 = c.msgs.find((m) => m.type === 'command_result' && m.requestId === 'r2') as Extract<ControlServerMessage, { type: 'command_result' }>;
    const key2 = r2.result.kind === 'candidates' ? r2.result.cards[0].key : '';
    c.send({ type: 'show_result', requestId: 'r2', key: key2 });
    await until(() => session.display.verse?.key === key2);
    expect(session.snapshot().held).toBe(true); // following paused until the broadcaster resumes
    c.send({ type: 'hold', on: false });
    c.ws.close();
  });

  it('an explicit typed reference navigates immediately', async () => {
    const c = control();
    await c.ready;
    c.send({ type: 'command', requestId: 'r9', text: 'surah maryam ayah 3', source: 'typed' });
    await until(() => session.display.verse?.key === '19:3');
    c.ws.close();
  });
});
