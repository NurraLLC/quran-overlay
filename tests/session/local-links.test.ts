import { mkdtempSync, readFileSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import path from 'node:path';
import { describe, expect, it } from 'vitest';
import { localLinks } from '../../src/server/local-links';
import { DEFAULT_STYLE } from '../../src/shared/contracts';

describe('self-hosted links', () => {
  it('survive a restart, and a replaced overlay link is kept', () => {
    const file = path.join(mkdtempSync(path.join(tmpdir(), 'qo-links-')), 'local-links.json');
    const first = localLinks(file);
    const again = localLinks(file);
    expect(again.links).toEqual(first.links);
    again.saveView('replacedOverlayLinkToken1234567');
    expect(localLinks(file).links.view).toBe('replacedOverlayLinkToken1234567');
    expect(localLinks(file).links.owner).toBe(first.links.owner);
  });

  it('are made fresh when the file is missing or damaged', () => {
    const file = path.join(mkdtempSync(path.join(tmpdir(), 'qo-links-')), 'local-links.json');
    writeFileSync(file, '{"owner":"short"}');
    const l = localLinks(file).links;
    expect(l.owner.length).toBeGreaterThanOrEqual(32);
    expect(JSON.parse(readFileSync(file, 'utf8')).owner).toBe(l.owner);
  });

  it('keeps the appearance through restarts and overlay-link replacement', () => {
    const file = path.join(mkdtempSync(path.join(tmpdir(), 'qo-look-')), 'local-links.json');
    const first = localLinks(file);
    const style = { ...DEFAULT_STYLE, englishScale: 1.4, captionPosition: 'top' as const, captionInset: 120, panelOpacity: 0.4 };
    first.saveStyle(style);
    const restarted = localLinks(file);
    expect(restarted.links.style).toEqual(style);
    restarted.saveView('replacementOverlayToken123456789');
    expect(localLinks(file).links).toMatchObject({ style, owner: first.links.owner, view: 'replacementOverlayToken123456789' });
  });

  it('loads old appearance records and ignores damaged settings without replacing valid links', () => {
    const file = path.join(mkdtempSync(path.join(tmpdir(), 'qo-look-')), 'local-links.json');
    const first = localLinks(file);
    const { englishScale, captionPosition, captionInset, panelOpacity, ...oldStyle } = DEFAULT_STYLE;
    writeFileSync(file, JSON.stringify({ ...first.links, style: { ...oldStyle, accent: '#5fbf98' } }));
    expect(localLinks(file).links.style).toEqual({ ...DEFAULT_STYLE, accent: '#5fbf98' });
    writeFileSync(file, JSON.stringify({ ...first.links, style: { ...DEFAULT_STYLE, captionInset: -900 } }));
    expect(localLinks(file).links).toEqual(first.links);
  });
});
