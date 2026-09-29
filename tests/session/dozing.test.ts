// The silence skipper closes the provider stream during a long pause: the screen keeps its ayah,
// and the next stream continues from the same place.
import { describe, expect, it } from 'vitest';
import { CommandResolver } from '../../src/server/commands/reducer';
import { Session } from '../../src/server/sessions';
import { fullCorpus, VirtualClock } from '../helpers';

describe('dozing between streams', () => {
  it('keeps the ayah on screen and follows on when recitation resumes', () => {
    const { corpus, ix } = fullCorpus();
    const clock = new VirtualClock();
    const s = new Session({
      corpus,
      ix,
      resolver: new CommandResolver(corpus, null, null),
      decisionClient: null,
      mode: 'deterministic',
      setup: { soniox: true, jev: { provider: null, configured: false, detail: '' }, semantic: () => '' },
      overlayUrl: (v) => v,
      clock,
    });
    let shown: string | null = null;
    s.onDisplay((d) => (shown = d.visible ? (d.verse?.key ?? null) : null));
    const say = (epoch: number, text: string) => {
      let seq = 0;
      text.split(' ').forEach((w, i) => {
        clock.t += 400;
        s.handle({ type: 'transcript', captureEpoch: epoch, seq: seq++, receivedAt: clock.t, tokens: [{ text: `${i ? ' ' : ''}${w}`, isFinal: true, startMs: i * 400, endMs: i * 400 + 350 }] });
      });
    };
    s.handle({ type: 'capture', captureEpoch: 1, event: 'starting' });
    s.handle({ type: 'capture', captureEpoch: 1, event: 'recording' });
    say(1, 'تبارك الذي بيده الملك وهو على كل شيء قدير');
    expect(shown).toBe('67:1');

    s.handle({ type: 'capture', captureEpoch: 1, event: 'dozing' });
    clock.t += 20_000;
    expect(shown).toBe('67:1');
    expect(s.snapshot().phase).toBe('dozing');

    s.handle({ type: 'capture', captureEpoch: 2, event: 'starting' });
    s.handle({ type: 'capture', captureEpoch: 2, event: 'recording' });
    say(2, 'الذي خلق الموت والحياة ليبلوكم أيكم أحسن عملا');
    expect(shown).toBe('67:2');
  });
});
