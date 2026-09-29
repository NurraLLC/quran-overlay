import { describe, expect, it } from 'vitest';
import { ListeningSafety } from '../../src/server/billing/listening-safety';

describe('private listening safety counters', () => {
  it('counts unproductive time across restarts and allows normal recitation to reset it', () => {
    const guard = new ListeningSafety(':memory:');
    try {
      guard.record('a', 'network', 45_000, false, 1000);
      guard.record('a', 'network', 44_000, false, 2000);
      expect(guard.status('a', 'network', 2001)).toMatchObject({ idleMs: 89_000, retryAfter: 0 });
      guard.record('a', 'network', 1000, true, 3000);
      expect(guard.status('a', 'network', 3001).idleMs).toBe(1000);
      guard.record('a', 'network', 89_000, false, 4000);
      expect(guard.status('a', 'network', 4001).retryAfter).toBe(300);
      expect(guard.status('a', 'network', 305_000)).toMatchObject({ idleMs: 0, retryAfter: 0 });
    } finally { guard.close(); }
  });

  it('uses a temporary network cooldown after repeated idle cutoffs from fresh identities', () => {
    const guard = new ListeningSafety(':memory:');
    try {
      for (let i = 0; i < 8; i++) guard.record(`visitor-${i}`, 'shared', 90_000, false, 1000 + i);
      expect(guard.status('fresh-cookie', 'shared', 1010).retryAfter).toBeGreaterThan(0);
      expect(guard.status('fresh-cookie', 'different', 1010).retryAfter).toBe(0);
    } finally { guard.close(); }
  });

  it('preserves a cooldown across a service restart', async () => {
    const { mkdtempSync, rmSync } = await import('node:fs');
    const { tmpdir } = await import('node:os');
    const { join } = await import('node:path');
    const dir = mkdtempSync(join(tmpdir(), 'reader-safety-'));
    const file = join(dir, 'safety.db');
    let guard = new ListeningSafety(file);
    guard.record('a', 'ip', 90_000, false, 1000);
    guard.close();
    guard = new ListeningSafety(file);
    try { expect(guard.status('a', 'ip', 2000).retryAfter).toBe(299); }
    finally { guard.close(); rmSync(dir, { recursive: true }); }
  });
});
