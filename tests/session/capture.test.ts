import { mkdtempSync, readdirSync } from 'node:fs';
import { tmpdir } from 'node:os';
import path from 'node:path';
import { describe, expect, it } from 'vitest';
import { CommandResolver } from '../../src/server/commands/reducer';
import { Session } from '../../src/server/sessions';
import { loadFixture, replay } from '../../src/replay/run';
import { Timeline } from '../../src/replay/synth';
import { fullCorpus } from '../helpers';

describe('diagnostic capture', () => {
  it('is off by default and, when enabled, writes replayable provider events (text only)', async () => {
    const { corpus, ix } = fullCorpus();
    const mk = (captureDir: string | null) =>
      new Session({
        corpus,
        ix,
        resolver: new CommandResolver(corpus, null, null),
        decisionClient: null,
        mode: 'deterministic',
        setup: { soniox: false, jev: { provider: null, configured: false, detail: '' }, semantic: () => '' },
        overlayUrl: (v) => v,
        captureDir,
      });
    const dir = mkdtempSync(path.join(tmpdir(), 'qo-cap-'));
    const off = mk(null);
    const on = mk(dir);
    const tl = new Timeline();
    for (const k of ['112:1', '112:2', '112:3', '112:4']) tl.reciteVerse(corpus.verse(k)!);
    for (const s of [off, on]) {
      s.handle({ type: 'capture', captureEpoch: 5, event: 'starting' });
      s.handle({ type: 'capture', captureEpoch: 5, event: 'recording' });
      let seq = 0;
      for (const e of tl.sorted()) if (e.type === 'result') s.handle({ type: 'transcript', captureEpoch: 5, seq: seq++, tokens: e.tokens, receivedAt: e.t });
    }
    const files = readdirSync(dir);
    expect(files).toEqual(['capture-5.jsonl']);
    const loaded = loadFixture(path.join(dir, files[0]), corpus);
    expect(loaded.label).toContain('capture');
    const r = await replay(loaded, corpus, ix, 'deterministic', { kind: 'none' });
    expect(r.timeline.filter((x) => x.event === 'commit').map((x) => x.key)).toContain('112:4');
  });
});
