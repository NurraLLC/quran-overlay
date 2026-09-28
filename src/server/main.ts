// npm start — loopback server on 127.0.0.1:4317 (or PORT). Prints the owner link.
import { existsSync, readFileSync } from 'node:fs';
import net from 'node:net';
import path from 'node:path';
import { buildApp } from './app';
import { CommandResolver } from './commands/reducer';
import { Corpus, loadCorpus } from './corpus/load';
import { ROOT } from './corpus/manifest';
import { JevClient, type DecisionClient, type JevGateway } from './providers/jev';
import { SemanticRetriever } from './search/semantic';
import { Session } from './sessions';
import { TRACKER_MODES, type TrackerMode } from './tracker/follower';
import { buildIndex } from './tracker/index';

function loadEnvFile() {
  const file = path.join(ROOT, '.env');
  if (!existsSync(file)) return;
  for (const line of readFileSync(file, 'utf8').split(/\r?\n/)) {
    const m = /^\s*([A-Z0-9_]+)\s*=\s*(.*)\s*$/.exec(line);
    if (m && process.env[m[1]] === undefined) process.env[m[1]] = m[2].replace(/^["']|["']$/g, '');
  }
}

async function portFree(port: number): Promise<boolean> {
  return new Promise((resolve) => {
    const srv = net.createServer();
    srv.once('error', () => resolve(false));
    srv.once('listening', () => srv.close(() => resolve(true)));
    srv.listen(port, '127.0.0.1');
  });
}

function decisionSetup(): { client: DecisionClient | null; provider: JevGateway | null; detail: string } {
  const provider = (process.env.JEV_PROVIDER || '').trim() as JevGateway | '';
  const keys: Record<JevGateway, string | undefined> = { typesafe: process.env.TYPESAFE_API_KEY, openrouter: process.env.OPENROUTER_API_KEY };
  const chosen: JevGateway | null = provider === 'typesafe' || provider === 'openrouter' ? provider : keys.typesafe ? 'typesafe' : keys.openrouter ? 'openrouter' : null;
  if (!chosen) return { client: null, provider: null, detail: 'No JEV key configured (set JEV_PROVIDER and TYPESAFE_API_KEY or OPENROUTER_API_KEY). Deterministic following, manual navigation and lexical search still work.' };
  const key = keys[chosen];
  if (!key) return { client: null, provider: chosen, detail: `JEV_PROVIDER=${chosen} but ${chosen === 'typesafe' ? 'TYPESAFE_API_KEY' : 'OPENROUTER_API_KEY'} is not set.` };
  try {
    return { client: new JevClient(chosen, key), provider: chosen, detail: `JEV via ${chosen === 'typesafe' ? 'TypeSafe direct' : 'OpenRouter Decisions'} (not live-verified in this build).` };
  } catch {
    return { client: null, provider: chosen, detail: 'JEV key has an invalid format.' };
  }
}

async function main() {
  loadEnvFile();
  const t0 = performance.now();
  const corpus = new Corpus(loadCorpus());
  const ix = buildIndex(corpus.verses);
  const semantic = new SemanticRetriever();
  void semantic.init();
  const jev = decisionSetup();
  const modeEnv = (process.env.TRACKER_MODE || 'hybrid') as TrackerMode;
  const mode: TrackerMode = TRACKER_MODES.includes(modeEnv) ? modeEnv : 'hybrid';
  const resolver = new CommandResolver(corpus, semantic, jev.client);

  let port = Number(process.env.PORT || 4317);
  if (!(await portFree(port))) {
    const wanted = port;
    for (port = wanted + 1; port < wanted + 20 && !(await portFree(port)); port++);
    console.log(`Port ${wanted} is in use; using ${port} instead.`);
  }
  const devOrigins = process.env.QO_DEV === '1' ? ['http://127.0.0.1:5173', 'http://localhost:5173'] : [];
  const publicOrigin = process.env.QO_DEV === '1' ? 'http://127.0.0.1:5173' : `http://127.0.0.1:${port}`;

  const session = new Session({
    corpus,
    ix,
    resolver,
    decisionClient: jev.client,
    mode,
    setup: {
      soniox: !!process.env.SONIOX_API_KEY,
      jev: { provider: jev.provider, configured: !!jev.client, detail: jev.detail },
      semantic: () => {
        const s = semantic.status;
        return s.state === 'ready' ? `ready (${s.model}, warm-up ${s.warmupMs} ms)` : s.state === 'loading' ? 'loading' : `${s.state}: ${'reason' in s ? s.reason : ''}`;
      },
    },
    overlayUrl: (view) => `${publicOrigin}/overlay#view=${view}`,
    captureDir: process.env.QO_DIAGNOSTIC_CAPTURE === '1' ? path.join(ROOT, 'data', 'captures') : null,
  });
  // QO_OWNER_TOKEN exists only so automated browser tests can open the control page; normal runs
  // generate a fresh random capability each start.
  const { app, ownerToken } = await buildApp({ session, port, sonioxApiKey: process.env.SONIOX_API_KEY, devOrigins, ownerToken: process.env.QO_OWNER_TOKEN || undefined });
  await app.listen({ host: '127.0.0.1', port });
  const ms = Math.round(performance.now() - t0);
  console.log(`Quran Overlay ready in ${ms} ms — corpus ${corpus.id}: ${corpus.verses.length} ayahs / ${corpus.data.chapters.length} surahs`);
  if (process.env.QO_DIAGNOSTIC_CAPTURE === '1') console.log('Diagnostic capture ON: recognized text tokens are written to data/captures/*.jsonl (no audio).');
  console.log(`Tracker mode: ${mode}. Soniox: ${process.env.SONIOX_API_KEY ? 'configured' : 'NOT configured (set SONIOX_API_KEY)'}. ${jev.detail}`);
  console.log(`\nOpen the control page (keep this link private):\n  ${publicOrigin}/control#owner=${ownerToken}\n`);
}

main().catch((e) => {
  console.error(e instanceof Error ? e.message : e);
  process.exit(1);
});
