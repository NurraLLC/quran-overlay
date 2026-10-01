// The charity stream: its settings and donations live in the streamer's session, are saved after each
// change and restored, reach the stream scene (overlay socket) and the control page at once, and only
// https links are accepted.
import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import { existsSync } from 'node:fs';
import WebSocket from 'ws';
import type { FastifyInstance } from 'fastify';
import { buildApp } from '../../src/server/app';
import { CommandResolver } from '../../src/server/commands/reducer';
import { Session, type SavedStream } from '../../src/server/sessions';
import type { ControlServerMessage, OverlayServerMessage, StreamState } from '../../src/shared/contracts';
import { fullCorpus } from '../helpers';

const { corpus, ix } = fullCorpus();
const make = (extra: Partial<ConstructorParameters<typeof Session>[0]> = {}) =>
  new Session({
    corpus,
    ix,
    resolver: new CommandResolver(corpus, null, null),
    decisionClient: null,
    mode: 'deterministic',
    setup: { soniox: false, jev: { provider: null, configured: false, detail: '' }, semantic: () => 'unavailable' },
    overlayUrl: (v) => `view:${v}`,
    ...extra,
  });

describe('charity stream in the session', () => {
  it('keeps settings and donations, totals them, and saves each change', () => {
    const saved: SavedStream[] = [];
    const s = make({ onStream: (st) => saved.push(st) });
    const seen: StreamState[] = [];
    s.onStream((st) => seen.push(st));
    s.handle({ type: 'stream_settings', patch: { partner: '  Water for All ', project: 'Wells', goal: 5000, raisedBefore: 250, link: 'https://example.org/give' } });
    expect(s.stream.settings).toMatchObject({ partner: 'Water for All', project: 'Wells', goal: 5000, link: 'https://example.org/give', title: 'Twenty-four hours of Quran' });
    s.handle({ type: 'donation', name: 'Aisha', amount: 50, message: '' });
    s.handle({ type: 'donation', name: '', amount: 20.5, message: 'For my late father' });
    expect(s.stream.total).toBe(320.5); // 250 given before + 50 + 20.5
    expect(s.stream.count).toBe(2);
    expect(s.stream.donations.map((d) => d.name)).toEqual(['', 'Aisha']); // newest first; '' is anonymous
    expect(seen.at(-1)?.total).toBe(320.5);
    expect(saved.at(-1)).toMatchObject({ total: 70.5, count: 2 });
    // A mistake taken back.
    s.handle({ type: 'donation_remove', id: s.stream.donations[1].id });
    expect(s.stream).toMatchObject({ total: 270.5, count: 1 });
    expect(saved.at(-1)?.donations.map((d) => d.name)).toEqual(['']);
  });

  it('accepts only https links, and changes nothing otherwise', () => {
    const s = make();
    expect(() => s.handle({ type: 'stream_settings', patch: { link: 'http://example.org' } } as never)).not.toThrow();
    expect(s.stream.settings.link).toBe('');
    s.handle({ type: 'stream_settings', patch: { link: 'https://example.org/give' } });
    expect(s.stream.settings.link).toBe('https://example.org/give');
  });

  it('comes back after a restart with its settings, donations and totals', () => {
    const saved: SavedStream[] = [];
    const a = make({ onStream: (st) => saved.push(st) });
    a.handle({ type: 'stream_settings', patch: { partner: 'Partner', startedAt: 1_000 } });
    a.handle({ type: 'donation', name: 'Yusuf', amount: 100, message: '' });
    const b = make({ stream: JSON.parse(JSON.stringify(saved.at(-1))) });
    expect(b.stream).toMatchObject({ total: 100, count: 1, settings: { partner: 'Partner', startedAt: 1_000 } });
    expect(b.stream.donations[0].name).toBe('Yusuf');
    // A damaged record is ignored rather than trusted.
    const c = make({ stream: { settings: { link: 'javascript:alert(1)' }, donations: [{ nope: true }], total: 'x' } });
    expect(c.stream).toMatchObject({ total: 0, count: 0, settings: { link: '' } });
  });
});

describe('charity stream over the sockets', () => {
  let app: FastifyInstance;
  let session: Session;
  let base = '';
  let cookie = '';
  const OWNER = 'stream-test-owner-token-000001';
  beforeAll(async () => {
    session = make({ overlayUrl: (v) => `${base}/overlay#view=${v}` });
    const port = 44170 + Math.floor(Math.random() * 500);
    ({ app } = await buildApp({ session, port, ownerToken: OWNER }));
    await app.listen({ host: '127.0.0.1', port });
    base = `http://127.0.0.1:${port}`;
    const res = await fetch(`${base}/api/owner/session`, { method: 'POST', headers: { 'content-type': 'application/json', origin: base }, body: JSON.stringify({ token: OWNER }) });
    cookie = res.headers.get('set-cookie')!.split(';')[0];
  });
  afterAll(async () => app?.close());

  const until = async (cond: () => boolean) => {
    const end = Date.now() + 3000;
    while (!cond()) {
      if (Date.now() > end) throw new Error('timeout');
      await new Promise((r) => setTimeout(r, 20));
    }
  };

  it('reaches the stream scene and the control page at once', async () => {
    const control = new WebSocket(`${base.replace('http', 'ws')}/ws/control`, { headers: { origin: base, cookie } });
    const toControl: ControlServerMessage[] = [];
    control.on('message', (d) => toControl.push(JSON.parse(String(d))));
    await new Promise<void>((r) => control.on('open', () => r()));
    await until(() => toControl.some((m) => m.type === 'stream'));

    const view = new URL(session.overlayUrl).hash.split('view=')[1];
    const scene = new WebSocket(`${base.replace('http', 'ws')}/ws/overlay`, { headers: { origin: base } });
    const toScene: OverlayServerMessage[] = [];
    scene.on('message', (d) => toScene.push(JSON.parse(String(d))));
    await new Promise<void>((r) => scene.on('open', () => r()));
    scene.send(JSON.stringify({ type: 'hello', view, role: 'overlay' }));
    await until(() => toScene.some((m) => m.type === 'stream'));

    control.send(JSON.stringify({ type: 'donation', name: 'Aisha', amount: 50 }));
    const latest = (ms: Array<ControlServerMessage | OverlayServerMessage>) => [...ms].reverse().find((m): m is { type: 'stream'; state: StreamState } => m.type === 'stream')?.state;
    await until(() => latest(toScene)?.donations[0]?.name === 'Aisha' && latest(toControl)?.count === 1);
    expect(latest(toScene)).toMatchObject({ total: 50, count: 1 });
    // The scene only receives; it cannot add donations.
    scene.send(JSON.stringify({ type: 'donation', name: 'Spoof', amount: 1 }));
    await new Promise((r) => setTimeout(r, 150));
    expect(session.stream.count).toBe(1);
    control.close();
    scene.close();
  });

  it.skipIf(!existsSync('dist/web/index.html'))('serves the stream page', async () => {
    const res = await fetch(`${base}/stream`);
    expect(res.status).toBe(200);
    expect(await res.text()).toContain('<div id="root">');
  });
});
