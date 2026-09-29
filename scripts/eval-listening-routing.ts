// Small live classifier smoke. Uses only this project's configured gateway; never executes navigation.
import { existsSync, writeFileSync } from 'node:fs';
import { ListeningCommands, type SpokenIntent } from '../src/server/commands/listening';
import { JevClient, type DecisionClient, type JevGateway } from '../src/server/providers/jev';
import { realClock } from '../src/server/tracker/scheduler';
if (existsSync('.env')) process.loadEnvFile('.env');
const gateway = (process.env.JEV_PROVIDER || 'openrouter') as JevGateway;
const key = gateway === 'typesafe' ? process.env.TYPESAFE_API_KEY : process.env.OPENROUTER_API_KEY;
if (!key) throw new Error('Selected JEV gateway is not configured.');
const base = new JevClient(gateway, key);
// Expected action: an intent that must run, or null for speech that must not act.
const cases: Array<[string, SpokenIntent | null]> = [
  ['Go to surah Maryam ayah three', 'navigate'],
  ['Surah 13, ayah 5.', 'navigate'],
  ['Find a Quran verse about patience', 'search'],
  ['The ayah about the orphan', 'search'],
  ['Where Allah says do not oppress the orphan', 'search'],
  ['Show the verse about the orphan', 'show'],
  ['Put up the ayah where Allah says He is closer than the jugular vein', 'show'],
  ['Go full English only mode', 'control'],
  ['Switch to Arabic only', 'control'],
  ['Pause following', 'control'],
  ['Go to Surah Fath', 'navigate'],
  ['Go to Inna Fatahna', 'navigate'],
  ['Surah about patience', 'search'],
  ['I was reading surah Maryam yesterday', null],
  ['Do not go to surah Maryam', null],
  ['Thanks for joining the stream everyone', null],
  ['Let me grab some water real quick', null],
];
const results = [];
for (const [text, expected] of cases) {
  let acted: SpokenIntent | null = null, route: string | null = null, error: string | null = null, latency: number | null = null;
  let answers: unknown = null;
  let done!: () => void;
  const finished = new Promise<void>(resolve => { done = resolve; });
  const client: DecisionClient = { gateway, evaluate: async (...args) => {
    try { const d = await base.evaluate(...args); answers = d.answers; const a = d.answers.route; route = a?.type === 'choice' ? a.choice : null; latency = d.latencyMs; return d; }
    catch (e) { error = (e as { code?: string }).code ?? 'ERROR'; throw e; }
    finally { done(); }
  } };
  const router = new ListeningCommands(client, realClock, (_t, _id, intent) => { acted = intent; });
  router.observe(text.split(' ').map(text => ({ text, index: -1, startMs: null, endMs: null })), false, true);
  let limit: ReturnType<typeof setTimeout>;
  await Promise.race([finished, new Promise<void>(resolve => { limit = setTimeout(resolve, 2100); })]);
  clearTimeout(limit!);
  await new Promise(resolve => setTimeout(resolve, 10));
  router.cancel();
  results.push({ text, expected, acted, route, error, answers, latencyMs: latency, passed: !error && route !== null && acted === expected });
  console.log(`${acted === expected && !error ? 'ok  ' : 'MISS'} ${text} -> ${error ?? acted ?? 'nothing'} (${route ?? '-'}, ${latency ?? '-'} ms)`);
}
const report = { kind: 'Live JEV routing on authored text requests; no speech recognition or navigation effect', gateway, results };
writeFileSync('data/processed/listening-routing-live.json', JSON.stringify(report, null, 2));
console.log(`${results.filter((r) => r.passed).length}/${results.length} routed as expected`);
