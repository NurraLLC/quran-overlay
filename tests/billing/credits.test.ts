// Listening credits: reserve on key, settle on stop, pools and caps.
import { afterEach, describe, expect, it } from 'vitest';
import { CreditStore, type CreditConfig } from '../../src/server/billing/credits';

const T0 = Date.UTC(2026, 8, 28, 12, 0, 0);
const S = 1000;
const cfg: CreditConfig = { freeSecondsPerMonth: 600, ipDailyFreeSeconds: 900, globalDailyFreeSeconds: 5000, holdMaxSeconds: 300, holdMinSeconds: 20 };
let store: CreditStore;
const make = (c: Partial<CreditConfig> = {}) => (store = new CreditStore(':memory:', { ...cfg, ...c }));
afterEach(() => store?.close());

describe('credit holds', () => {
  it('reserves at most what is left, charges only the time used, and frees the rest', () => {
    make();
    const h = store.reserve('u1', 'ip1', T0);
    expect(h).toEqual({ id: expect.any(String), maxSeconds: 300 });
    expect(store.balance('u1', 'ip1', T0 + 10 * S)).toMatchObject({ free: 600, reserved: 300, available: 300 });
    expect(store.settle('u1', T0 + 90 * S)).toBe(90);
    expect(store.balance('u1', 'ip1', T0 + 91 * S)).toMatchObject({ free: 510, reserved: 0, available: 510, freeUsedThisMonth: 90 });
  });

  it('caps a key at the remaining balance and refuses when nothing is left', () => {
    make();
    store.reserve('u1', 'ip1', T0);
    store.settle('u1', T0 + 300 * S);
    store.reserve('u1', 'ip1', T0 + 400 * S);
    store.settle('u1', T0 + 650 * S);
    const h = store.reserve('u1', 'ip1', T0 + 700 * S);
    expect(h).toMatchObject({ maxSeconds: 50 });
    store.settle('u1', T0 + 800 * S);
    expect(store.reserve('u1', 'ip1', T0 + 900 * S)).toMatchObject({ error: 'no_credits', balance: { available: 0, limitedBy: 'month' } });
  });

  it('charges a hold that was never settled in full once its maximum has passed', () => {
    make();
    store.reserve('u1', 'ip1', T0);
    expect(store.balance('u1', 'ip1', T0 + 301 * S)).toMatchObject({ free: 300, reserved: 0, freeUsedThisMonth: 300 });
  });

  it('counts overlapping streams (a reconnect) once', () => {
    make();
    store.reserve('u1', 'ip1', T0);
    store.reserve('u1', 'ip1', T0 + 60 * S);
    expect(store.settle('u1', T0 + 100 * S)).toBe(100);
    expect(store.balance('u1', 'ip1', T0 + 101 * S).freeUsedThisMonth).toBe(100);
  });

  it('drops a hold whose key could not be minted without charge', () => {
    make();
    const h = store.reserve('u1', 'ip1', T0) as { id: string };
    store.release(h.id);
    expect(store.balance('u1', 'ip1', T0 + 400 * S)).toMatchObject({ free: 600, reserved: 0 });
  });
});

describe('credit pools and caps', () => {
  it('uses free time first, then purchased time', () => {
    make();
    store.grant('u1', 400, 'test purchase', T0);
    store.reserve('u1', 'ip1', T0);
    store.settle('u1', T0 + 300 * S);
    store.reserve('u1', 'ip1', T0 + 400 * S);
    store.settle('u1', T0 + 700 * S);
    expect(store.balance('u1', 'ip1', T0 + 701 * S)).toMatchObject({ free: 0, paid: 400, limitedBy: null }); // bought time remains, so nothing is limiting
    store.reserve('u1', 'ip1', T0 + 800 * S);
    store.settle('u1', T0 + 900 * S);
    expect(store.balance('u1', 'ip1', T0 + 901 * S)).toMatchObject({ free: 0, paid: 300 });
  });

  it('shares one daily free allowance per network, whatever the cookies', () => {
    make();
    for (const u of ['a', 'b']) {
      store.reserve(u, 'shared-ip', T0);
      store.settle(u, T0 + 300 * S);
    }
    store.reserve('c', 'shared-ip', T0);
    store.settle('c', T0 + 300 * S);
    expect(store.balance('d', 'shared-ip', T0 + 400 * S)).toMatchObject({ free: 0, limitedBy: 'network' });
    expect(store.balance('d', 'other-ip', T0 + 400 * S).free).toBe(600);
    // Purchased time is not limited by the network cap.
    store.grant('d', 120, 'test purchase', T0);
    expect(store.reserve('d', 'shared-ip', T0 + 500 * S)).toMatchObject({ maxSeconds: 120 });
  });

  it("counts other visitors' open streams against the network cap (no parallel streams past it)", () => {
    make({ ipDailyFreeSeconds: 400 });
    expect(store.reserve('a', 'shared', T0)).toMatchObject({ maxSeconds: 300 });
    // b on the same network may only use what a's open stream leaves.
    expect(store.reserve('b', 'shared', T0 + S)).toMatchObject({ maxSeconds: 100 });
    expect(store.reserve('c', 'shared', T0 + 2 * S)).toMatchObject({ error: 'no_credits', balance: { limitedBy: 'network' } });
    // Once a stops early, the unused reservation returns to the network.
    store.settle('a', T0 + 60 * S);
    expect(store.balance('c', 'shared', T0 + 61 * S).free).toBe(400 - 60 - 100);
  });

  it('stops free time for everyone at the service ceiling, and renews each month', () => {
    make({ globalDailyFreeSeconds: 200 });
    store.reserve('a', 'ip1', T0);
    store.settle('a', T0 + 200 * S);
    expect(store.balance('b', 'ip2', T0 + 300 * S)).toMatchObject({ free: 0, limitedBy: 'service' });
    const nextMonth = Date.UTC(2026, 9, 1, 12);
    expect(store.balance('a', 'ip1', nextMonth)).toMatchObject({ free: 200, freeUsedThisMonth: 0 });
  });
});

describe('sponsored pool', () => {
  it('is used after free and bought time, at most a daily amount per visitor, and never below zero', () => {
    make({ poolDailySecondsPerVisitor: 200 });
    expect(store.grantPool(1000, 'gift1')).toBe(true);
    expect(store.grantPool(1000, 'gift1')).toBe(false); // same payment again
    store.grant('u1', 100, 'test', T0);
    expect(store.balance('u1', 'ip1', T0)).toMatchObject({ free: 600, paid: 100, sponsored: 200, pool: 1000, available: 900 });
    store.reserve('u1', 'ip1', T0);
    store.settle('u1', T0 + 300 * S); // all free
    store.reserve('u1', 'ip1', T0 + 400 * S);
    store.settle('u1', T0 + 700 * S); // 300 free
    store.reserve('u1', 'ip1', T0 + 800 * S);
    store.settle('u1', T0 + 1100 * S); // 100 bought, then 200 sponsored
    expect(store.balance('u1', 'ip1', T0 + 1200 * S)).toMatchObject({ free: 0, paid: 0, sponsored: 0, pool: 800, available: 0 });
    // Another visitor still has their own daily share of the pool.
    expect(store.balance('u2', 'ip2', T0 + 1200 * S)).toMatchObject({ sponsored: 200, pool: 800 });
    // Next day the visitor's share returns.
    expect(store.balance('u1', 'ip1', T0 + 86_400 * S)).toMatchObject({ sponsored: 200 });
  });

  it('adds the column to a ledger made before sponsored time', async () => {
    const { mkdtempSync } = await import('node:fs');
    const { tmpdir } = await import('node:os');
    const path = await import('node:path');
    const { DatabaseSync } = await import('node:sqlite');
    const file = path.join(mkdtempSync(path.join(tmpdir(), 'qo-ledger-')), 'credits.db');
    const old = new DatabaseSync(file);
    old.exec('CREATE TABLE holds (id TEXT PRIMARY KEY, user_id TEXT NOT NULL, ip TEXT NOT NULL, minted_at INTEGER NOT NULL, max_seconds INTEGER NOT NULL, settled_at INTEGER, free_seconds INTEGER, paid_seconds INTEGER, day TEXT, month TEXT)');
    old.close();
    store = new CreditStore(file, cfg);
    expect(store.balance('u1', 'ip1', T0)).toMatchObject({ free: 600, pool: 0 });
  });
});

describe('free for everyone from the shared pool', () => {
  it('never promises the same pool seconds to simultaneous visitors', () => {
    make({ freeSecondsPerMonth: 0, poolDailySecondsPerVisitor: 600 });
    store.grantPool(400, 'launch', null, null, T0);
    expect(store.reserve('a', 'ip1', T0)).toMatchObject({ maxSeconds: 300 });
    expect(store.reserve('b', 'ip2', T0)).toMatchObject({ maxSeconds: 100 });
    expect(store.reserve('c', 'ip3', T0)).toMatchObject({ error: 'no_credits' });
    store.settle('a', T0 + 60 * S);
    expect(store.balance('c', 'ip3', T0 + 61 * S).available).toBe(240);
    store.settle('b', T0 + 100 * S);
    expect(store.poolSeconds()).toBe(240);
  });

  it('reserves the shared network limit across different visitor cookies', () => {
    make({ freeSecondsPerMonth: 0, poolDailySecondsPerVisitor: 600, poolDailySecondsPerNetwork: 400 });
    store.grantPool(10_000, 'launch', null, null, T0);
    expect(store.reserve('a', 'shared-ip', T0)).toMatchObject({ maxSeconds: 300 });
    expect(store.reserve('b', 'shared-ip', T0)).toMatchObject({ maxSeconds: 100 });
    expect(store.reserve('c', 'shared-ip', T0)).toMatchObject({ error: 'no_credits', balance: { limitedBy: 'share' } });
    expect(store.reserve('d', 'different-ip', T0)).toMatchObject({ maxSeconds: 300 });
  });

  it('returns a failed provider reservation to the shared pool immediately', () => {
    make({ freeSecondsPerMonth: 0 });
    store.grantPool(300, 'launch', null, null, T0);
    const hold = store.reserve('a', 'ip1', T0);
    if ('error' in hold) throw new Error('expected a hold');
    expect(store.reserve('b', 'ip2', T0)).toMatchObject({ error: 'no_credits' });
    store.release(hold.id);
    expect(store.reserve('b', 'ip2', T0)).toMatchObject({ maxSeconds: 300 });
  });

  it('gives each visitor a daily share, limits a network, and says why when nothing is left', () => {
    make({ freeSecondsPerMonth: 0, poolDailySecondsPerVisitor: 300, poolDailySecondsPerNetwork: 400 });
    expect(store.balance('u1', 'ip1', T0)).toMatchObject({ available: 0, limitedBy: 'pool', sharePerDay: 300 });
    store.grantPool(10_000, 'gift', 1000, 'usd', T0);
    expect(store.balance('u1', 'ip1', T0)).toMatchObject({ free: 0, sponsored: 300, available: 300, limitedBy: null });
    store.reserve('u1', 'ip1', T0);
    store.settle('u1', T0 + 300 * S);
    expect(store.balance('u1', 'ip1', T0 + 301 * S)).toMatchObject({ available: 0, limitedBy: 'share' });
    // A new cookie on the same network gets only what is left of the network's share.
    expect(store.balance('u2', 'ip1', T0 + 301 * S)).toMatchObject({ sponsored: 100 });
    expect(store.balance('u3', 'ip2', T0 + 301 * S)).toMatchObject({ sponsored: 300 });
    const s = store.poolStats(T0 + 400 * S);
    expect(s).toMatchObject({ given: 10_000, used: 300, left: 9_700, givenThisMonth: 10_000, giftsThisMonth: 1, lastGiftAt: T0, recitersThisWeek: 1, recitedThisWeek: 300 });
  });
});
