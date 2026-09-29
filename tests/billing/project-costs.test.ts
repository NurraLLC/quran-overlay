import { describe, expect, it } from 'vitest';
import { CreditStore } from '../../src/server/billing/credits';

const config = { freeSecondsPerMonth: 0, ipDailyFreeSeconds: 0, globalDailyFreeSeconds: 0, holdMinSeconds: 20, holdMaxSeconds: 1200, costCentsPerHour: 10 };
describe('shared project expenses', () => {
  it('protects an operating reserve without charging it as an expense', () => {
    const store = new CreditStore(':memory:', { ...config, operatingReserveUsdMicros: 6_000_000 });
    try {
      store.grantPool(360_000, 'owner', 1000, 'usd');
      expect(store.poolStats()).toMatchObject({given:360_000, used:0, costs:0, operatingReserve:216_000, left:144_000});
      store.recordCost('invoice', 'hosting', 4_000_000);
      expect(store.poolStats()).toMatchObject({costs:144_000, operatingReserve:216_000, left:0});
      expect(store.reserve('reader', 'network')).toHaveProperty('error');
      store.grantPool(3600, 'new-funding');
      expect(store.reserve('reader', 'network')).toHaveProperty('id');
      const s=store.poolStats();
      expect(s.given).toBe(s.used+s.costs+s.operatingReserve+s.left);
    } finally { store.close(); }
    for(const value of [-1,NaN,Infinity,0.5]) expect(()=>new CreditStore(':memory:', {...config, operatingReserveUsdMicros:value})).toThrow();
  });
  it('commits funding and fees together and preserves pre-imported receipts', () => {
    const store = new CreditStore(':memory:', config);
    try {
      store.recordCost('conflict', 'hosting', 500_000);
      const before = store.poolStats();
      expect(() => store.grantPool(360_000, 'gift', 1000, 'usd', Date.now(), { id: 'conflict', usdMicros: 500_000 })).toThrow();
      expect(store.poolStats()).toEqual(before);
      store.recordCost('stripe:txn', 'payment_fees', 500_000);
      store.grantPool(360_000, 'gift', 1000, 'usd', Date.now(), { id: 'stripe:txn', usdMicros: 500_000 });
      expect(store.poolStats()).toMatchObject({ given: 360_000, costs: 36_000, left: 324_000 });
      store.grantPool(360_000, 'gift', 1000, 'usd', Date.now(), { id: 'stripe:txn', usdMicros: 500_000 });
      expect(store.poolSeconds()).toBe(324_000);
    } finally { store.close(); }
  });
  it('deducts fees once, supports corrections, and separates expenses from recitation', () => {
    const store = new CreditStore(':memory:', config);
    try {
      store.grantPool(360_000, 'owner', 1000, 'usd');
      expect(store.recordCost('fee-1', 'payment_fees', 500_000)).toBe(true);
      expect(store.recordCost('fee-1', 'payment_fees', 500_000)).toBe(false);
      expect(store.poolStats()).toMatchObject({ given: 360_000, used: 0, costs: 18_000, left: 342_000 });
      expect(store.recordCost('fee-1', 'payment_fees', 400_000)).toBe(true);
      expect(store.poolStats()).toMatchObject({ costs: 14_400, left: 345_600 });
      expect(() => store.recordCost('fee-1', 'hosting', 1)).toThrow();
      expect(store.poolSeconds()).toBe(345_600);
    } finally { store.close(); }
  });
  it('keeps an uncovered cost negative and blocks new listening until funding covers it', () => {
    const store = new CreditStore(':memory:', config);
    try {
      store.recordCost('server', 'hosting', 1_000_000);
      expect(store.poolSeconds()).toBe(-36_000);
      expect(store.reserve('reader', 'network')).toHaveProperty('error');
      store.grantPool(72_000, 'owner');
      expect(store.poolSeconds()).toBe(36_000);
      expect(store.reserve('reader', 'network')).toHaveProperty('id');
    } finally { store.close(); }
  });
  it('rejects invalid amounts and rounds tiny provider charges conservatively', () => {
    const store = new CreditStore(':memory:', config);
    try {
      for (const amount of [-1, NaN, Infinity, 0.5, 1e13]) expect(() => store.recordCost('bad', 'ai', amount)).toThrow();
      expect(store.poolSeconds()).toBe(0);
      store.recordCost('request-1', 'ai', 1);
      expect(store.poolSeconds()).toBe(-1);
    } finally { store.close(); }
  });
});
