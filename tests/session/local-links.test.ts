import { mkdtempSync, readFileSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import path from 'node:path';
import { describe, expect, it } from 'vitest';
import { localLinks } from '../../src/server/local-links';

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
});
