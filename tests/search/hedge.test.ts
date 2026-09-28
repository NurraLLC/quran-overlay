import { describe, expect, it } from 'vitest';
import { CommandResolver } from '../../src/server/commands/reducer';
import type { Decision, DecisionClient, Question } from '../../src/server/providers/jev';
import { fullCorpus } from '../helpers';

// Answers "first passage" for every choice question; `plan` decides per call: 'hang' | 'ok' | 'fail'.
function client(plan: Array<'hang' | 'ok' | 'fail'>): DecisionClient & { calls: number } {
  const c = {
    gateway: 'openrouter' as const,
    calls: 0,
    evaluate(_s: unknown, qs: Record<string, Question>, opts: { signal?: AbortSignal }): Promise<Decision> {
      const mode = plan[c.calls++] ?? 'ok';
      return new Promise((resolve, reject) => {
        opts.signal?.addEventListener('abort', () => reject(Object.assign(new Error('x'), { code: 'CANCELLED' })));
        if (mode === 'hang') return;
        if (mode === 'fail') return setTimeout(() => reject(Object.assign(new Error('x'), { code: 'SERVICE_UNAVAILABLE' })), 10);
        const answers: Decision['answers'] = {};
        for (const [id, q] of Object.entries(qs)) {
          if (q.type === 'noul') answers[id] = { type: 'noul', noul: 0.95 };
          else {
            const opts2 = Object.keys(q.criteria);
            answers[id] = { type: 'choice', choice: opts2[0], probabilities: Object.fromEntries(opts2.map((o, i) => [o, i === 0 ? 1 : 0])), confidence: 1, tied: false };
          }
        }
        setTimeout(() => resolve({ id: 'x', model: 'm', gateway: 'openrouter', answers, usage: { inputTokens: 1, outputTokens: 1, cost: 0 }, latencyMs: 1 }), 20);
      });
    },
  };
  return c;
}

describe('hedged search decisions', () => {
  it('a stalled first request is hedged once and the duplicate answers inside the deadline', async () => {
    const c = client(['hang', 'ok']);
    const r = new CommandResolver(fullCorpus().corpus, null, c);
    const t0 = performance.now();
    const res = await r.search('with hardship comes ease');
    expect(c.calls).toBe(2);
    expect(performance.now() - t0).toBeLessThan(1500);
    expect(res.kind === 'candidates' && res.confirmedKey).toBeTruthy();
  });

  it('a fast answer never triggers the hedge', async () => {
    const c = client(['ok']);
    await new CommandResolver(fullCorpus().corpus, null, c).search('with hardship comes ease');
    await new Promise((r) => setTimeout(r, 800));
    expect(c.calls).toBe(1);
  });

  it('when both requests stall, search still returns unconfirmed retrieved passages by the deadline', async () => {
    const c = client(['hang', 'hang']);
    const t0 = performance.now();
    const res = await new CommandResolver(fullCorpus().corpus, null, c).search('with hardship comes ease');
    expect(performance.now() - t0).toBeLessThan(2600);
    expect(res.kind).toBe('candidates');
    if (res.kind === 'candidates') {
      expect(res.confirmedKey).toBeNull();
      expect(res.cards.length).toBeGreaterThan(0);
    }
  });

  it('never hedges after a non-transient failure such as a rate limit', async () => {
    const c = client(['fail', 'ok']);
    const orig = c.evaluate.bind(c);
    c.evaluate = (st, qs, o) => (c.calls === 0 ? (c.calls++, Promise.reject(Object.assign(new Error('rl'), { code: 'RATE_LIMITED' }))) : orig(st, qs, o));
    const res = await new CommandResolver(fullCorpus().corpus, null, c).search('with hardship comes ease');
    await new Promise((r) => setTimeout(r, 800));
    expect(c.calls).toBe(1);
    expect(res.kind === 'candidates' && res.status).toMatch(/RATE_LIMITED/);
  });
});
