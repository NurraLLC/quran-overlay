import { describe, expect, it } from 'vitest';
import { ListeningCommands } from '../../src/server/commands/listening';
import type { Decision, DecisionClient } from '../../src/server/providers/jev';
import { VirtualClock, flush } from '../helpers';

const words = (s: string) => s.split(' ').map(text => ({ text, index: -1, startMs: null, endMs: null }));
function answer(route: string): Decision {
  return { id: 'route', gateway: 'openrouter', model: 'typesafe/jev-1.13', latencyMs: 10, usage: { inputTokens: 0, outputTokens: 0, cost: 0 }, answers: { route: { type: 'choice', choice: route, probabilities: { NAVIGATE: route === 'NAVIGATE' ? .99 : .005, SEARCH: .005, COMMENTARY: route === 'COMMENTARY' ? .99 : .005 }, confidence: .99, tied: false }, explicit: { type: 'noul', noul: route === 'COMMENTARY' ? .01 : .99 } } };
}
function probs(p: Record<string, number>): Decision {
  const choice = Object.entries(p).sort((x, y) => y[1] - x[1])[0][0];
  return { ...answer('NAVIGATE'), answers: { route: { type: 'choice', choice, probabilities: p, confidence: .9, tied: false } } };
}
async function routed(p: Record<string, number>, text = 'show the verse about the orphan') {
  const clock = new VirtualClock(), runs: string[] = [];
  const client: DecisionClient = { gateway: 'openrouter', evaluate: async () => probs(p) };
  const r = new ListeningCommands(client, clock, (_t, _id, intent) => runs.push(intent));
  r.observe(words(text), false, true);
  await clock.advance(1); await flush();
  return runs;
}
describe('spoken English finds passages', () => {
  it('a confident request to show a described passage acts as show', async () => {
    expect(await routed({ SHOW: .97, SEARCH: .02, COMMENTARY: .01, NAVIGATE: 0 })).toEqual(['show']);
  });
  it('speech about a passage that is not sure enough to change the screen still searches privately', async () => {
    expect(await routed({ SHOW: .6, SEARCH: .35, COMMENTARY: .05, NAVIGATE: 0 })).toEqual(['search']);
    expect(await routed({ SEARCH: .57, SHOW: .04, COMMENTARY: .39, NAVIGATE: 0 }, 'where Allah says do not oppress the orphan')).toEqual(['search']);
  });
  it('commentary and split decisions do nothing', async () => {
    expect(await routed({ COMMENTARY: .97, SEARCH: .03, SHOW: 0, NAVIGATE: 0 }, 'thanks for joining everyone')).toEqual([]);
    expect(await routed({ SEARCH: .45, COMMENTARY: .45, SHOW: .1, NAVIGATE: 0 }, 'that ayah is beautiful')).toEqual([]);
  });
});

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
