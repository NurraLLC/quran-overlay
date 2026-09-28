// Small live classifier smoke. Uses only this project's configured gateway; never executes navigation.
import { existsSync, writeFileSync } from 'node:fs';
import { ListeningCommands } from '../src/server/commands/listening';
import { JevClient, type DecisionClient, type JevGateway } from '../src/server/providers/jev';
import { realClock } from '../src/server/tracker/scheduler';
if (existsSync('.env')) process.loadEnvFile('.env');
const gateway = (process.env.JEV_PROVIDER || 'openrouter') as JevGateway;
const key = gateway === 'typesafe' ? process.env.TYPESAFE_API_KEY : process.env.OPENROUTER_API_KEY;
if (!key) throw new Error('Selected JEV gateway is not configured.');
const base = new JevClient(gateway, key);
const cases: Array<[string, boolean]> = [
  ['Go to surah Maryam ayah three', true],
  ['Surah 13, ayah 5.', true],
  ['Find a Quran verse about patience', true],
  ['I was reading surah Maryam yesterday', false],
  ['Do not go to surah Maryam', false],
  ['All praise belongs to God, Lord of the worlds', false],
];
const results = [];
for (const [text, expectedAction] of cases.filter(([text]) => !process.argv.includes('--misses') || text.startsWith('Surah 13') || text.startsWith('Find a'))) {
  let acted = false, route: string | null = null, error: string | null = null, latency: number | null = null;
  let answers: unknown = null;
  let done!: () => void;
  const finished = new Promise<void>(resolve => { done = resolve; });
  const client: DecisionClient = { gateway, evaluate: async (...args) => {
    try { const d = await base.evaluate(...args); answers = d.answers; const a = d.answers.route; route = a?.type === 'choice' ? a.choice : null; latency = d.latencyMs; return d; }
    catch (e) { error = (e as { code?: string }).code ?? 'ERROR'; throw e; }
    finally { done(); }
  } };
  const router = new ListeningCommands(client, realClock, () => { acted = true; });
  router.observe(text.split(' ').map(text => ({ text, index: -1, startMs: null, endMs: null })), false, true);
  let limit: ReturnType<typeof setTimeout>;
  await Promise.race([finished, new Promise<void>(resolve => { limit = setTimeout(resolve, 2100); })]);
  clearTimeout(limit!);
  await new Promise(resolve => setTimeout(resolve, 10));
  router.cancel();
  results.push({ text, expectedAction, acted, route, error, answers, latencyMs: latency, semanticCheckPassed: !error && route !== null && acted === expectedAction });
}
const report = { kind: 'Live JEV routing on six authored text requests; no speech recognition or navigation effect', gateway, results };
writeFileSync('data/processed/listening-routing-live.json', JSON.stringify(report, null, 2));
console.log(JSON.stringify(report, null, 2));
