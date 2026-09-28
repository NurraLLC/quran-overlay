// Ported behaviour: "each finalize returns only that breath's final words" and "audio before a
// finalize is sent before it" (Moard soniox_stream tests) → push-to-talk window separation.
import { describe, expect, it } from 'vitest';
import { TokenRouter } from '../../src/web/audio/command-lane';
import type { WireToken } from '../../src/shared/transcript';

const t = (text: string, startMs: number, endMs: number, isFinal = true): WireToken => ({ text, startMs, endMs, isFinal });

describe('push-to-talk token router', () => {
  it('routes recitation before the press to recitation and command words to the command only', () => {
    const r = new TokenRouter();
    expect(r.route([t(' قل', 0, 300), t(' هو', 320, 600)]).recitation).toHaveLength(2);
    r.begin(1000);
    const a = r.route([t(' الله', 700, 950), t(' go', 1100, 1300), t(' to', 1300, 1400, false)]);
    expect(a.recitation.map((x) => x.text)).toEqual([' الله']);
    r.release(2000);
    const b = r.route([t(' to', 1300, 1400), t(' two', 1450, 1700), t(' fifty', 1700, 1900), t('<fin>', 2000, 2000)]);
    expect(b.finalized).toBe(true);
    expect(b.recitation).toHaveLength(0);
    expect(r.finish()).toEqual({ text: 'go to two fifty', clean: true, reason: null });
    // After the window closes, everything is recitation again.
    expect(r.route([t(' احد', 2600, 3000)]).recitation).toHaveLength(1);
  });

  it('a second command cannot inherit the first command’s words', () => {
    const r = new TokenRouter();
    r.begin(0);
    r.route([t(' next', 100, 300)]);
    r.release(400);
    r.route([t('<fin>', 400, 400)]);
    expect(r.finish().text).toBe('next');
    r.begin(5000);
    r.route([t(' previous', 5100, 5400)]);
    r.release(5500);
    r.route([t('<fin>', 5500, 5500)]);
    expect(r.finish().text).toBe('previous');
  });

  it('a word straddling the press, Arabic inside the window, or a missing final make the capture unclean', () => {
    const r = new TokenRouter();
    r.begin(1000);
    r.route([t(' الرحيم', 800, 1200), t(' next', 1300, 1500)]);
    r.release(1600);
    expect(r.finish()).toMatchObject({ clean: false });

    r.begin(0);
    r.route([t(' next', 100, 300, false)]);
    r.release(400);
    expect(r.finish(true)).toMatchObject({ clean: false, text: 'next' });
  });

  it('never routes markers into the command text', () => {
    const r = new TokenRouter();
    r.begin(0);
    r.route([t(' next', 100, 300), t('<end>', 300, 300)]);
    r.release(400);
    r.route([t('<fin>', 400, 400)]);
    expect(r.finish().text).toBe('next');
  });
});
