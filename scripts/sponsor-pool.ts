// npm run pool:add -- <hours> [note]
// Adds hours to the shared sponsored-listening pool of the hosted service (for gifts received outside
// Stripe, or the owner funding free listening). Uses QO_STATE_DIR like the server (default data/state).
import { randomBytes } from 'node:crypto';
import path from 'node:path';
import { CreditStore } from '../src/server/billing/credits';
import { ROOT } from '../src/server/corpus/manifest';

const hours = Number(process.argv[2]);
if (!Number.isFinite(hours) || hours <= 0 || hours > 100_000) {
  console.error('Usage: npm run pool:add -- <hours> [note]');
  process.exit(2);
}
const note = process.argv.slice(3).join(' ').slice(0, 80) || 'owner';
const store = new CreditStore(path.join(process.env.QO_STATE_DIR || path.join(ROOT, 'data', 'state'), 'credits.db'));
store.grantPool(hours * 3600, `manual:${note}:${randomBytes(6).toString('hex')}`);
console.log(`Added ${hours} h. The sponsored pool now holds ${(store.poolSeconds() / 3600).toFixed(1)} h.`);
store.close();
