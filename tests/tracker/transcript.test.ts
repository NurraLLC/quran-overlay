import { describe, expect, it } from 'vitest';
import { TranscriptBuffer, type WireToken } from '../../src/shared/transcript';

const f = (text: string, startMs?: number, endMs?: number): WireToken => ({ text, isFinal: true, startMs, endMs });
const p = (text: string): WireToken => ({ text, isFinal: false });

describe('Soniox transcript assembly (ported: soniox_stream.py _take)', () => {
  it('never types <end>/<fin> markers as words', () => {
    const b = new TranscriptBuffer();
    const r = b.apply([f(' قل'), f(' هو'), f('<end>')]);
    expect(r.endpoint).toBe(true);
    expect(b.finals.map((w) => w.text)).toEqual(['قل', 'هو']);
    b.apply([f(' الله'), f('<fin>')]);
    expect(b.finals.map((w) => w.text)).toEqual(['قل', 'هو', 'الله']);
    expect(b.finals.some((w) => w.text.includes('<'))).toBe(false);
  });

  it('joins subword tokens and keeps the open word provisional until a boundary proves it complete', () => {
    const b = new TranscriptBuffer();
    b.apply([f(' الرح'), f('من')]);
    expect(b.finals).toHaveLength(0);
    expect(b.provisionalWords().map((w) => w.text)).toEqual(['الرحمن']);
    b.apply([f(' الرحيم')]);
    expect(b.finals.map((w) => w.text)).toEqual(['الرحمن']);
  });

  it('replaces (never appends) the provisional suffix on each result', () => {
    const b = new TranscriptBuffer();
    b.apply([f(' بسم'), p(' الل')]);
    expect(b.finals.map((w) => w.text)).toEqual(['بسم']); // closed: the next token starts a new word
    b.apply([p(' الله'), p(' الرح')]);
    expect(b.provisionalWords().map((w) => w.text)).toEqual(['الله', 'الرح']);
    b.apply([f(' الله'), p(' الرحمن')]);
    expect(b.finals.map((w) => w.text)).toEqual(['بسم', 'الله']);
    expect(b.provisionalWords().map((w) => w.text)).toEqual(['الرحمن']);
  });

  it('keeps genuinely repeated words (no text de-duplication)', () => {
    const b = new TranscriptBuffer();
    b.apply([f(' فبأي'), f(' فبأي'), f(' آلاء'), f(' ')]);
    expect(b.finals.map((w) => w.text)).toEqual(['فبأي', 'فبأي', 'آلاء']);
  });

  it('carries word timing from the first and last subword', () => {
    const b = new TranscriptBuffer();
    b.apply([f(' الح', 100, 300), f('مد', 300, 520), f(' ', 520, 520)]);
    expect(b.finals[0]).toMatchObject({ text: 'الحمد', startMs: 100, endMs: 520, index: 0 });
  });
});
