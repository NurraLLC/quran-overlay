import { describe, expect, it } from 'vitest';
import { ListeningCommands } from '../../src/server/commands/listening';
import type { Decision, DecisionClient } from '../../src/server/providers/jev';
import { VirtualClock, flush } from '../helpers';

const words = (s: string) => s.split(' ').map(text => ({ text, index: -1, startMs: null, endMs: null }));
function answer(route: string): Decision {
  return { id: 'route', gateway: 'openrouter', model: 'typesafe/jev-1.13', latencyMs: 10, usage: { inputTokens: 0, outputTokens: 0, cost: 0 }, answers: { route: { type: 'choice', choice: route, probabilities: { NAVIGATE: route === 'NAVIGATE' ? .99 : .005, SEARCH: .005, COMMENTARY: route === 'COMMENTARY' ? .99 : .005 }, confidence: .99, tied: false }, explicit: { type: 'noul', noul: route === 'COMMENTARY' ? .01 : .99 } } };
}
describe('requests inside continuous listening', () => {
  it('an abandoned provider deadline cannot cancel a newer request', async () => {
    const clock = new VirtualClock(), runs: string[] = [];
    const resolves: Array<(d: Decision) => void> = [];
    const slow: DecisionClient = { gateway: 'openrouter', evaluate: () => new Promise(r => resolves.push(r)) };
    const r = new ListeningCommands(slow, clock, text => runs.push(text));
    r.observe(words('go to surah two'), false, true);
    await clock.advance(1000);
    r.cancel(true);
    r.observe(words('go to surah three'), false, true);
    await clock.advance(900);
    resolves[1](answer('NAVIGATE')); await flush();
    resolves[0](answer('NAVIGATE')); await flush();
    expect(runs).toEqual(['go to surah three']);
  });
  it('never calls JEV for Arabic; waits for finalized English; executes a settled request once', async () => {
    const clock = new VirtualClock(), calls: string[] = [], runs: string[] = [];
    const client: DecisionClient = { gateway: 'openrouter', evaluate: async state => { calls.push(JSON.stringify(state)); return answer('NAVIGATE'); } };
    const r = new ListeningCommands(client, clock, text => runs.push(text));
    r.observe(words('الحمد لله رب العالمين'), false, true);
    await clock.advance(2000); expect(calls).toHaveLength(0);
    r.observe(words('go to surah two'), true, false);
    await clock.advance(2000); expect(calls).toHaveLength(0);
    r.observe(words('go to surah two ayah five'), false, true);
    await clock.advance(1); await flush();
    expect(runs).toEqual(['go to surah two ayah five']);
    r.observe(words('go to surah two ayah five'), false, true);
    await clock.advance(2000); expect(calls).toHaveLength(1);
  });
  it('does not execute English commentary or a late answer after cancellation', async () => {
    const clock = new VirtualClock(), runs: string[] = [];
    const no: DecisionClient = { gateway: 'openrouter', evaluate: async () => answer('COMMENTARY') };
    const r = new ListeningCommands(no, clock, text => runs.push(text));
    r.observe(words('I love this passage'), false, true);
    await clock.advance(1); await flush(); expect(runs).toEqual([]);
    let resolve!: (d: Decision) => void;
    const slow: DecisionClient = { gateway: 'openrouter', evaluate: () => new Promise(r => { resolve = r; }) };
    const stale = new ListeningCommands(slow, clock, text => runs.push(text));
    stale.observe(words('go to surah two'), false, true);
    await clock.advance(1); stale.cancel(); resolve(answer('NAVIGATE')); await flush();
    expect(runs).toEqual([]);
  });
});
