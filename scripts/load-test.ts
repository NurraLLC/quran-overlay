// npm run load -- [--readers 10000] [--listeners 25,50,100] [--hold 20] [--max-listeners N]
//
// Capacity of the hosted service on THIS machine, never a deployment: a server built exactly as
// main.ts builds hosted mode (corpus, resources, word meanings, Latin reader, credits and links in a
// temporary directory) runs in one process; simulated visitors run in another, which also plays the
// recogniser, replaying a real owner capture at recording speed. No provider or payment is called
// (the recogniser's key minting is a stand-in; audio is dummy bytes, never recitation).
//
// Visitors arrive like the reader page: /api/me, the control socket, chapters, one surah. Listeners
// also recite through the real audio relay (a ticket, the relay socket, audio bytes, the recogniser's
// results back through the relay and on to the control socket), each replaying one of several owner
// captures of different surahs, so shared caches are not flattered. The server reports its CPU,
// memory, sessions and event-loop delay every two seconds; the visitor side measures /healthz latency
// and how soon a display change follows each recogniser result. --max-listeners sets the server's cap
// (default: none that matters, to find the machine's limit; production defaults to 60).
import { spawn } from 'node:child_process';
import { randomBytes } from 'node:crypto';
import { existsSync, mkdtempSync, readFileSync } from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { monitorEventLoopDelay } from 'node:perf_hooks';
import { fileURLToPath } from 'node:url';
import WebSocket, { WebSocketServer } from 'ws';

const arg = (name: string, fallback: string) => {
  const i = process.argv.indexOf(`--${name}`);
  return i >= 0 ? process.argv[i + 1] : fallback;
};
const role = process.argv[2];
// Owner recitation of different surahs: Ya-Sin and Al-Baqarah, Al-Fath, Ar-Rahman (two), At-Tin and Ad-Duha.
const CAPTURES = arg('captures', ['1790662311912', '1790649756773', '1790662980328', '1790663289785', '1790665914683'].map((c) => `data/captures/capture-${c}.jsonl`).join(',')).split(',');

// ---------------- server ----------------

async function server(port: number, providerUrl: string, maxListeners: number) {
  const { buildApp } = await import('../src/server/app');
  const { CreditStore, DEFAULT_CREDITS } = await import('../src/server/billing/credits');
  const { SessionHub } = await import('../src/server/billing/hub');
  const { OverlayLinks } = await import('../src/server/billing/overlay-links');
  const { VisitorIdentity } = await import('../src/server/billing/identity');
  const { ListeningSafety } = await import('../src/server/billing/listening-safety');
  const { CommandResolver } = await import('../src/server/commands/reducer');
  const { Corpus, loadCorpus } = await import('../src/server/corpus/load');
  const { PROCESSED_DIR } = await import('../src/server/corpus/manifest');
  const { WordGlosses } = await import('../src/server/corpus/wbw');
  const { ResourceCatalog } = await import('../src/server/resources/catalog');
  const { Transliteration } = await import('../src/server/search/transliteration');
  const { Session } = await import('../src/server/sessions');
  const { buildIndex } = await import('../src/server/tracker/index');
  const { LatinReader } = await import('../src/server/tracker/latin');

  const corpus = new Corpus(loadCorpus());
  const ix = buildIndex(corpus.verses);
  const catalog = new ResourceCatalog(corpus, ix);
  const glosses = WordGlosses.load();
  const translit = path.join(PROCESSED_DIR, 'translit-en.json');
  const latin = existsSync(translit) ? new LatinReader(ix, corpus, JSON.parse(readFileSync(translit, 'utf8')).verses) : null;
  const resolver = new CommandResolver(corpus, null, null, catalog, Transliteration.load(corpus));
  const dir = mkdtempSync(path.join(os.tmpdir(), 'qo-load-'));
  const credits = new CreditStore(path.join(dir, 'credits.db'), { ...DEFAULT_CREDITS, freeSecondsPerMonth: 0, ipDailyFreeSeconds: 0, globalDailyFreeSeconds: 0, poolDailySecondsPerVisitor: 7200, poolDailySecondsPerNetwork: 14_400 });
  credits.grantPool(10_000_000, 'load-test');
  const links = new OverlayLinks(path.join(dir, 'links.db'));
  type Options = ConstructorParameters<typeof Session>[0];
  const options = (extra: Partial<Options> = {}): Options => ({
    corpus,
    ix,
    resolver,
    decisionClient: null,
    mode: 'hybrid',
    setup: { soniox: true, jev: { provider: null, configured: false, detail: 'load test' }, semantic: () => 'off' },
    overlayUrl: (v) => `http://127.0.0.1:${port}/overlay#view=${v}`,
    captureDir: null,
    catalog,
    glosses,
    latin: { get: () => latin },
    ...extra,
  });
  const hub = new SessionHub(
    (visitor) => {
      const saved = links.get(visitor);
      const view = saved?.view ?? randomBytes(18).toString('base64url');
      if (!saved) links.saveView(visitor, view);
      return new Session(options({ viewToken: view, onViewToken: (v) => links.saveView(visitor, v), style: saved?.style ?? undefined, onStyle: (s) => links.saveStyle(visitor, s) }));
    },
    undefined,
    undefined,
    (view) => links.visitorOf(view),
  );
  const mint = (async () => new Response(JSON.stringify({ api_key: 'stand-in', expires_at: new Date(Date.now() + 60_000).toISOString() }), { status: 201 })) as unknown as typeof fetch;
  const { app } = await buildApp({
    port,
    sonioxApiKey: 'load-test',
    fetchImpl: mint,
    speechEndpoint: providerUrl,
    hosted: { hub, credits, identity: new VisitorIdentity(randomBytes(48)), trustProxy: true, safety: new ListeningSafety(path.join(dir, 'safety.db')), isRecitation: () => true, reading: new Session(options()), maxListeners },
  });
  await app.listen({ host: '127.0.0.1', port });
  const loop = monitorEventLoopDelay({ resolution: 10 });
  loop.enable();
  let cpu = process.cpuUsage();
  let at = performance.now();
  setInterval(() => {
    const now = performance.now();
    const used = process.cpuUsage(cpu);
    cpu = process.cpuUsage();
    const m = process.memoryUsage();
    const ms = (ns: number) => Math.round(ns / 1e5) / 10;
    console.log(JSON.stringify({ metric: true, cpu: Math.round(((used.user + used.system) / 1000 / (now - at)) * 100), rssMB: Math.round(m.rss / 1e6), heapMB: Math.round(m.heapUsed / 1e6), sessions: hub.size, loopP50: ms(loop.percentile(50)), loopP99: ms(loop.percentile(99)), loopMax: ms(loop.max) }));
    loop.reset();
    at = now;
  }, 2000).unref();
  console.log(JSON.stringify({ ready: true }));
}

// ---------------- visitors ----------------

type Result = { t: number; tokens: Array<{ text: string; isFinal: boolean; startMs?: number; endMs?: number }> };

async function visitors(base: string, providerPort: number) {
  const readersWanted = Number(arg('readers', '10000'));
  const steps = arg('listeners', '25,50,100').split(',').map(Number).filter((n) => n > 0);
  const hold = Number(arg('hold', '20')) * 1000;
  const wsBase = base.replace('http', 'ws');
  const recordings = CAPTURES.map((file) => {
    const results: Result[] = readFileSync(file, 'utf8').split(/\r?\n/).filter(Boolean).map((l) => JSON.parse(l)).filter((e) => e.type === 'result');
    return { results, length: results.at(-1)!.t + 2000 };
  });
  const report = (label: string, o: Record<string, unknown>) => console.log(JSON.stringify({ phase: label, ...o }));

  // The recogniser stand-in: after the relay's config, replay one of the captures from a random point,
  // as Soniox results, at recording speed, forever.
  const provider = new WebSocketServer({ port: providerPort, host: '127.0.0.1' });
  provider.on('connection', (ws) => {
    ws.once('message', () => {
      const { results, length } = recordings[Math.floor(Math.random() * recordings.length)];
      const start = Date.now();
      const offset = Math.floor(Math.random() * length);
      let i = results.findIndex((r) => r.t >= offset);
      let lap = 0;
      const next = () => {
        if (ws.readyState !== WebSocket.OPEN) return;
        if (i < 0 || i >= results.length) {
          i = 0;
          lap++;
        }
        const r = results[i++];
        const due = start + (r.t + lap * length - offset);
        setTimeout(() => {
          if (ws.readyState !== WebSocket.OPEN) return;
          const shift = lap * length;
          const elapsed = Date.now() - start;
          ws.send(JSON.stringify({ tokens: r.tokens.map((k) => ({ text: k.text, is_final: k.isFinal, start_ms: (k.startMs ?? 0) + shift, end_ms: (k.endMs ?? 0) + shift })), total_audio_proc_ms: elapsed, sent_at: Date.now() }));
          next();
        }, Math.max(0, due - Date.now()));
      };
      next();
    });
  });

  // Health probe: how long an ordinary request waits for the server.
  const health: number[] = [];
  const probe = setInterval(async () => {
    const t0 = performance.now();
    try {
      await fetch(`${base}/healthz`);
      health.push(performance.now() - t0);
    } catch {
      health.push(10_000);
    }
  }, 250);
  const q = (xs: number[], p: number) => (xs.length ? Math.round([...xs].sort((a, b) => a - b)[Math.min(xs.length - 1, Math.floor(xs.length * p))]) : null);
  const drain = (xs: number[]) => xs.splice(0, xs.length);

  // Visitors.
  type V = { i: number; cookie: string; ip: string; ws: WebSocket; bytes: number; msgs: number; lastSent: number; displayLag: number[] };
  const all: V[] = [];
  let errors = 0;
  const errorKinds = new Map<string, number>();
  const fail = (kind: string) => {
    errors++;
    errorKinds.set(kind, (errorKinds.get(kind) ?? 0) + 1);
  };
  const visit = async (i: number): Promise<V | null> => {
    const ip = `10.${(i >> 16) & 255}.${(i >> 8) & 255}.${i & 255}`;
    const h = { origin: base, 'x-forwarded-for': ip };
    try {
      const me = await fetch(`${base}/api/me`, { headers: h });
      if (!me.ok) return fail(`me ${me.status}`), null;
      await me.arrayBuffer();
      const cookie = me.headers.get('set-cookie')!.split(';')[0];
      const ws = new WebSocket(`${wsBase}/ws/control`, { headers: { ...h, cookie } });
      const v: V = { i, cookie, ip, ws, bytes: 0, msgs: 0, lastSent: 0, displayLag: [] };
      ws.on('message', (d: Buffer) => {
        v.bytes += d.length;
        v.msgs++;
        if (v.lastSent && d.subarray(0, 20).toString().includes('"display"')) {
          const lag = performance.now() - v.lastSent;
          if (lag < 400) v.displayLag.push(lag);
          v.lastSent = 0;
        }
      });
      ws.on('error', () => fail('control socket'));
      await new Promise<void>((resolve, reject) => {
        ws.once('open', () => resolve());
        ws.once('error', reject);
      });
      const c = await fetch(`${base}/api/chapters`, { headers: { ...h, cookie } });
      await c.arrayBuffer();
      const s = await fetch(`${base}/api/surah/${1 + (i % 114)}`, { headers: { ...h, cookie } });
      if (!s.ok) fail(`surah ${s.status}`);
      await s.arrayBuffer();
      return v;
    } catch (e) {
      fail(e instanceof Error ? e.message.slice(0, 40) : 'error');
      return null;
    }
  };

  // Phase 1: readers arrive (in waves, like a busy hour compressed).
  const t0 = Date.now();
  const WAVE = 100;
  for (let n = 0; n < readersWanted; n += WAVE) {
    const wave = await Promise.all(Array.from({ length: Math.min(WAVE, readersWanted - n) }, (_, k) => visit(n + k)));
    for (const v of wave) if (v) all.push(v);
    if ((n / WAVE) % 20 === 0) report('arriving', { connected: all.length, errors, healthP99: q(health, 0.99) });
  }
  const arrival = (Date.now() - t0) / 1000;
  drain(health);
  await new Promise((r) => setTimeout(r, hold));
  report('readers', { connected: all.length, errors, arrivalS: arrival, healthP50: q(health, 0.5), healthP99: q(health, 0.99), receivedKB: Math.round(all.reduce((n, v) => n + v.bytes, 0) / 1024) });

  // Phase 2: listeners recite, in steps, while every reader stays connected.
  const listening: Array<{ v: V; stop: () => void }> = [];
  const listen = async (v: V) => {
    const epoch = Date.now() * 10 + (v.i % 10);
    let seq = 0;
    const control = (m: unknown) => v.ws.readyState === WebSocket.OPEN && v.ws.send(JSON.stringify(m));
    control({ type: 'capture', captureEpoch: epoch, event: 'starting' });
    control({ type: 'capture', captureEpoch: epoch, event: 'recording' });
    const start = Date.now();
    const forward = (tokens: Result['tokens']) => {
      v.lastSent = performance.now();
      control({ type: 'transcript', captureEpoch: epoch, seq: seq++, tokens, receivedAt: v.lastSent, audioMs: Date.now() - start });
    };
    const h = { origin: base, 'x-forwarded-for': v.ip, cookie: v.cookie };
    const key = await fetch(`${base}/api/soniox/temporary-key`, { method: 'POST', headers: h });
    if (!key.ok) {
      fail(`key ${key.status}`);
      return () => undefined;
    }
    const { api_key, stt_ws_url } = (await key.json()) as { api_key: string; stt_ws_url: string };
    const audio = new WebSocket(stt_ws_url, { headers: h });
    let pump: ReturnType<typeof setInterval> | null = null;
    audio.on('open', () => {
      audio.send(JSON.stringify({ api_key, audio_format: 'auto' }));
      const chunk = Buffer.alloc(4000, 1);
      pump = setInterval(() => audio.readyState === WebSocket.OPEN && audio.send(chunk), 100);
    });
    audio.on('message', (d: Buffer) => {
      const r = JSON.parse(String(d)) as { tokens?: Array<{ text: string; is_final: boolean; start_ms: number; end_ms: number }>; sent_at?: number; error_message?: string };
      if (r.error_message) return fail(`relay: ${r.error_message.slice(0, 30)}`);
      if (r.sent_at) relayLag.push(Date.now() - r.sent_at);
      if (r.tokens?.length) forward(r.tokens.map((k) => ({ text: k.text, isFinal: k.is_final, startMs: k.start_ms, endMs: k.end_ms })));
    });
    audio.on('close', (code) => code !== 1000 && code !== 1005 && fail(`relay closed ${code}`));
    audio.on('error', () => fail('relay socket'));
    return () => {
      if (pump) clearInterval(pump);
      audio.close();
      control({ type: 'capture', captureEpoch: epoch, event: 'stopped' });
    };
  };
  const relayLag: number[] = [];
  let next = 0;
  for (const target of steps) {
    while (listening.length < target && next < all.length) {
      const v = all[next++];
      const stop = await listen(v);
      listening.push({ v, stop });
    }
    for (const l of listening) drain(l.v.displayLag);
    drain(health);
    drain(relayLag);
    const errorsBefore = errors;
    await new Promise((r) => setTimeout(r, hold));
    const lags = listening.flatMap((l) => l.v.displayLag);
    report('listening', { listeners: listening.length, readers: all.length, healthP50: q(health, 0.5), healthP99: q(health, 0.99), resultToDisplayP50: q(lags, 0.5), resultToDisplayP99: q(lags, 0.99), relayForwardP99: q(relayLag, 0.99), newErrors: errors - errorsBefore });
  }
  for (const l of listening) l.stop();
  clearInterval(probe);
  report('done', { errors, errorKinds: Object.fromEntries(errorKinds) });
  for (const v of all) v.ws.close();
  provider.close();
  setTimeout(() => process.exit(0), 500);
}

// ---------------- orchestrator ----------------

async function main() {
  const port = 46000 + Math.floor(Math.random() * 1000);
  const providerPort = port + 1;
  const base = `http://127.0.0.1:${port}`;
  if (!/^http:\/\/(127\.0\.0\.1|localhost)(:\d+)?$/.test(base)) throw new Error('The load test only runs against this machine.');
  const self = fileURLToPath(import.meta.url);
  const tsx = path.join('node_modules', 'tsx', 'dist', 'cli.mjs');
  const srv = spawn(process.execPath, ['--max-old-space-size=4096', tsx, self, 'server', String(port), `ws://127.0.0.1:${providerPort}`, arg('max-listeners', '100000')], { stdio: ['ignore', 'pipe', 'inherit'] });
  const metrics: Array<Record<string, number>> = [];
  let phase = 'starting';
  await new Promise<void>((resolve) => {
    let buf = '';
    srv.stdout!.on('data', (d: Buffer) => {
      buf += d.toString();
      let nl: number;
      while ((nl = buf.indexOf('\n')) >= 0) {
        const line = buf.slice(0, nl).trim();
        buf = buf.slice(nl + 1);
        if (!line.startsWith('{')) continue;
        const m = JSON.parse(line);
        if (m.ready) resolve();
        if (m.metric) {
          metrics.push({ ...m, phase });
          console.log(`  server  cpu ${String(m.cpu).padStart(3)}%  rss ${String(m.rssMB).padStart(5)} MB  heap ${String(m.heapMB).padStart(5)} MB  sessions ${String(m.sessions).padStart(6)}  loop p50 ${m.loopP50} ms  p99 ${m.loopP99} ms  max ${m.loopMax} ms`);
        }
      }
    });
  });
  const cli = spawn(process.execPath, ['--max-old-space-size=4096', tsx, self, 'visitors', base, String(providerPort), ...process.argv.slice(2)], { stdio: ['ignore', 'pipe', 'inherit'] });
  let buf = '';
  cli.stdout!.on('data', (d: Buffer) => {
    buf += d.toString();
    let nl: number;
    while ((nl = buf.indexOf('\n')) >= 0) {
      const line = buf.slice(0, nl).trim();
      buf = buf.slice(nl + 1);
      if (!line.startsWith('{')) continue;
      const m = JSON.parse(line);
      phase = m.phase;
      console.log(`visitors ${JSON.stringify(m)}`);
    }
  });
  await new Promise((r) => cli.on('exit', r));
  srv.kill();
}

if (role === 'server') void server(Number(process.argv[3]), process.argv[4], Number(process.argv[5]));
else if (role === 'visitors') void visitors(process.argv[3], Number(process.argv[4]));
else void main();
