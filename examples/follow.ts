// Follow a recitation and find ayahs from your own code.
//   npx tsx examples/follow.ts
// Needs the corpus (npm run corpus:fetch && npm run corpus:import -- --manifest corpus/sources.json).
// No keys: this uses the deterministic tracker and local search only.
import { CommandResolver } from '../src/server/commands/reducer';
import { Corpus, loadCorpus } from '../src/server/corpus/load';
import { Session } from '../src/server/sessions';
import { buildIndex } from '../src/server/tracker/index';

const corpus = new Corpus(loadCorpus());
const ix = buildIndex(corpus.verses);
const resolver = new CommandResolver(corpus, null, null);

// 1. Find: references, surah names and plain-English descriptions resolve to ayah keys.
for (const q of ['2:255', 'yaseen', 'surah about elephants']) {
  const r = await resolver.resolve(q, null);
  const keys = r.kind === 'navigate' ? [r.key] : r.kind === 'candidates' ? r.cards.slice(0, 3).map((c) => c.key) : [];
  console.log(`find "${q}" -> ${keys.join(', ') || r.kind}`);
}

// 2. Follow: feed the words your speech recogniser hears; get the ayah and word being recited.
const session = new Session({
  corpus,
  ix,
  resolver,
  decisionClient: null,
  mode: 'deterministic',
  setup: { soniox: false, jev: { provider: null, configured: false, detail: '' }, semantic: () => '' },
  overlayUrl: (v) => v,
});
let last = '';
session.onDisplay((d) => {
  const at = d.verse ? `${d.verse.key}${d.cursor ? ` word ${d.cursor.from + 1}` : ''}` : 'nothing yet';
  if (at !== last) console.log(`  on screen: ${at}`);
  last = at;
});

// Stand-in for a recogniser: Al-Ikhlas, one word at a time, as final tokens.
const heard = 'بسم الله الرحمن الرحيم قل هو الله احد الله الصمد لم يلد ولم يولد ولم يكن له كفوا احد'.split(' ');
const epoch = 1;
session.handle({ type: 'capture', captureEpoch: epoch, event: 'recording' });
console.log('follow:');
heard.forEach((text, i) => {
  console.log(`  heard: ${text}`);
  session.handle({ type: 'transcript', captureEpoch: epoch, seq: i, receivedAt: i * 450, tokens: [{ text: `${i ? ' ' : ''}${text}`, isFinal: true, startMs: i * 450, endMs: i * 450 + 400 }] });
});
session.handle({ type: 'capture', captureEpoch: epoch, event: 'stopped' });
process.exit(0);
