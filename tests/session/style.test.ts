import { describe, expect, it } from 'vitest';
import { ControlClientMessageSchema, DEFAULT_STYLE, DisplayStyleSchema, StylePatchSchema } from '../../src/shared/contracts';
import { Session } from '../../src/server/sessions';
import { CommandResolver } from '../../src/server/commands/reducer';
import { fullCorpus } from '../helpers';

describe('overlay appearance updates', () => {
  it('never fills omitted patch fields with snapshot defaults', () => {
    expect(StylePatchSchema.parse({})).toEqual({});
    expect(StylePatchSchema.parse({ accent: '#7fb2e5' })).toEqual({ accent: '#7fb2e5' });
    expect(ControlClientMessageSchema.parse({ type: 'style', patch: { captionInset: 120 } })).toEqual({ type: 'style', patch: { captionInset: 120 } });
  });

  it('keeps the broadcaster’s choices when a different control is adjusted', () => {
    const { corpus, ix } = fullCorpus();
    const session = new Session({ corpus, ix, resolver: new CommandResolver(corpus, null, null), decisionClient: null,
      mode: 'deterministic', setup: { soniox: false, jev: { provider: null, configured: false, detail: '' }, semantic: () => '' }, overlayUrl: () => '' });
    const chosen = { ...DEFAULT_STYLE, layout: 'lowerthird' as const, language: 'arabic' as const, readingMode: 'ayah' as const,
      captionPosition: 'top' as const, englishScale: 1.4, groupShort: false, showNext: false, credit: false };
    session.handle(ControlClientMessageSchema.parse({ type: 'style', patch: chosen }));
    for (const patch of [{ captionInset: 120 }, { panelOpacity: 0.4 }, { accent: '#7fb2e5' }])
      session.handle(ControlClientMessageSchema.parse({ type: 'style', patch }));
    expect(session.snapshot().display.style).toEqual({ ...chosen, captionInset: 120, panelOpacity: 0.4, accent: '#7fb2e5' });
    session.dispose();
  });

  it('defaults new fields in older full snapshots and rejects unsafe geometry', () => {
    const { englishScale, captionPosition, captionInset, panelOpacity, ...old } = DEFAULT_STYLE;
    expect(DisplayStyleSchema.parse(old)).toEqual(DEFAULT_STYLE);
    for (const patch of [{ captionInset: -1 }, { captionInset: 900 }, { panelOpacity: 2 }, { englishScale: 5 }, { captionPosition: 'center' }])
      expect(StylePatchSchema.safeParse(patch).success).toBe(false);
  });
});
