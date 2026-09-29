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
    expect(store.balance('u1', 'ip1', T0 + 701 * S)).toMatchObject({ free: 0, paid: 400, limitedBy: 'month' });
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
