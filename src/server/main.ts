// npm start — loopback server on 127.0.0.1:4317 (or PORT). Prints the owner link.
import { existsSync, mkdirSync, readFileSync } from 'node:fs';
import { CreditStore, DEFAULT_CREDITS } from './billing/credits';
import { SessionHub } from './billing/hub';
import { VisitorIdentity } from './billing/identity';
import { parsePacks, StripeBilling } from './billing/stripe';
import net from 'node:net';
import path from 'node:path';
import { buildApp, type HostedOptions } from './app';
import { CommandResolver } from './commands/reducer';
import { Corpus, loadCorpus } from './corpus/load';
import { ROOT } from './corpus/manifest';
import { JevClient, type DecisionClient, type JevGateway } from './providers/jev';
import { SemanticRetriever } from './search/semantic';
import { Session } from './sessions';
import { TRACKER_MODES, type TrackerMode } from './tracker/follower';
import { buildIndex } from './tracker/index';
import { ResourceCatalog } from './resources/catalog';
import { WordGlosses } from './corpus/wbw';
import { Transliteration } from './search/transliteration';

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
  if (!chosen) return { client: null, provider: null, detail: 'No JEV key configured (set JEV_PROVIDER and TYPESAFE_API_KEY or OPENROUTER_API_KEY). Deterministic following, manual navigation and search still work.' };
  const key = keys[chosen];
  if (!key) return { client: null, provider: chosen, detail: `JEV_PROVIDER=${chosen} but ${chosen === 'typesafe' ? 'TYPESAFE_API_KEY' : 'OPENROUTER_API_KEY'} is not set.` };
  try {
    return { client: new JevClient(chosen, key), provider: chosen, detail: `JEV via ${chosen === 'typesafe' ? 'TypeSafe direct' : 'OpenRouter Decisions'}; in hybrid mode it is asked only when the tracker is unsure, and every answer is re-checked locally.` };
  } catch {
    return { client: null, provider: chosen, detail: 'JEV key has an invalid format.' };
  }
}

/**
 * Hosted service: one session per visitor and metered listening. Free allowances are hours, from the
 * environment (defaults: 10 h per visitor per month, 2 h per network per day, 200 h per day overall).
 */
function hostedSetup(create: () => Session): HostedOptions {
  const hours = (name: string, fallback: number) => Math.round((Number(process.env[name]) || fallback) * 3600);
  const stateDir = process.env.QO_STATE_DIR || path.join(ROOT, 'data', 'state');
  mkdirSync(stateDir, { recursive: true });
  const credits = new CreditStore(path.join(stateDir, 'credits.db'), {
    ...DEFAULT_CREDITS,
    freeSecondsPerMonth: hours('QO_FREE_HOURS_PER_MONTH', 10),
    ipDailyFreeSeconds: hours('QO_FREE_HOURS_PER_NETWORK_DAY', 2),
    globalDailyFreeSeconds: hours('QO_FREE_HOURS_PER_SERVICE_DAY', 200),
  });
  return {
    hub: new SessionHub(create),
    credits,
    identity: VisitorIdentity.fromFile(path.join(stateDir, 'identity.key'), process.env.QO_SECRET),
    publicOrigin: process.env.QO_PUBLIC_ORIGIN || undefined,
    trustProxy: process.env.QO_TRUST_PROXY === '1',
    // Buying listening time turns on only with both Stripe keys (test keys work the same way).
    billing: process.env.STRIPE_SECRET_KEY && process.env.STRIPE_WEBHOOK_SECRET ? new StripeBilling(process.env.STRIPE_SECRET_KEY, process.env.STRIPE_WEBHOOK_SECRET, parsePacks(process.env.QO_PACKS)) : null,
  };
}

async function main() {
  loadEnvFile();
  // `--capture` is equivalent to QO_DIAGNOSTIC_CAPTURE=1 (for launchers that cannot set env vars).
  if (process.argv.includes('--capture')) process.env.QO_DIAGNOSTIC_CAPTURE = '1';
  const t0 = performance.now();
  const corpus = new Corpus(loadCorpus());
  const ix = buildIndex(corpus.verses);
  const catalog = new ResourceCatalog(corpus, ix);
  const semantic = new SemanticRetriever();
  void semantic.init();
  const jev = decisionSetup();
  const modeEnv = (process.env.TRACKER_MODE || 'hybrid') as TrackerMode;
  const mode: TrackerMode = TRACKER_MODES.includes(modeEnv) ? modeEnv : 'hybrid';
  const resolver = new CommandResolver(corpus, semantic, jev.client, catalog, Transliteration.load(corpus));

  let port = Number(process.env.PORT || 4317);
  if (!(await portFree(port))) {
    const wanted = port;
    for (port = wanted + 1; port < wanted + 20 && !(await portFree(port)); port++);
    console.log(`Port ${wanted} is in use; using ${port} instead.`);
  }
  const devOrigins = process.env.QO_DEV === '1' ? ['http://127.0.0.1:5173', 'http://localhost:5173'] : [];
  const publicOrigin = process.env.QO_DEV === '1' ? 'http://127.0.0.1:5173' : `http://127.0.0.1:${port}`;

  const hostedMode = process.env.QO_HOSTED === '1';
  const sessionOptions = (hosted: boolean): ConstructorParameters<typeof Session>[0] => ({
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
    overlayUrl: (view) => `${hosted && process.env.QO_PUBLIC_ORIGIN ? process.env.QO_PUBLIC_ORIGIN : publicOrigin}/overlay#view=${view}`,
    // Diagnostic transcripts are never written for visitors of the hosted service.
    captureDir: !hosted && process.env.QO_DIAGNOSTIC_CAPTURE === '1' ? path.join(ROOT, 'data', 'captures') : null,
    catalog,
    glosses,
  });
  const glosses = WordGlosses.load();
  const session = hostedMode ? undefined : new Session(sessionOptions(false));
  const hosted = hostedMode ? hostedSetup(() => new Session(sessionOptions(true))) : undefined;
  // QO_OWNER_TOKEN exists only so automated browser tests can open the control page; normal runs
  // generate a fresh random capability each start.
  const { app, ownerToken } = await buildApp({ session, hosted, port, sonioxApiKey: process.env.SONIOX_API_KEY, devOrigins, ownerToken: process.env.QO_OWNER_TOKEN || undefined });
  await app.listen({ host: '127.0.0.1', port });
  const ms = Math.round(performance.now() - t0);
  console.log(`Quran Overlay ready in ${ms} ms — corpus ${corpus.id}: ${corpus.verses.length} ayahs / ${corpus.data.chapters.length} surahs`);
  if (process.env.QO_DIAGNOSTIC_CAPTURE === '1') console.log('Diagnostic capture ON: recognized text tokens are written to data/captures/*.jsonl (no audio).');
  console.log(`Tracker mode: ${mode}. Soniox: ${process.env.SONIOX_API_KEY ? 'configured' : 'NOT configured (set SONIOX_API_KEY)'}. ${jev.detail}`);
  if (hosted) {
    const c = hosted.credits.cfg;
    const h = (sec: number) => `${+(sec / 3600).toFixed(2)} h`;
    console.log(`\nHosted mode: every visitor gets their own session and ${h(c.freeSecondsPerMonth)} of free listening per month (${h(c.ipDailyFreeSeconds)} per network per day, ${h(c.globalDailyFreeSeconds)} per day overall).`);
    console.log(`Buying listening time: ${hosted.billing ? `on (${hosted.billing.packs.map((p) => p.label).join(', ')})` : 'off (set STRIPE_SECRET_KEY and STRIPE_WEBHOOK_SECRET)'}.`);
    console.log(`Open: ${process.env.QO_PUBLIC_ORIGIN || publicOrigin}/\n`);
  } else console.log(`\nOpen the control page (keep this link private):\n  ${publicOrigin}/control#owner=${ownerToken}\n`);
}

main().catch((e) => {
  console.error(e instanceof Error ? e.message : e);
  process.exit(1);
});
