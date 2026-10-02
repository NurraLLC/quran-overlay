// Self-hosted runs keep the private control link and the OBS overlay link across restarts, so a
// restart does not silently break the browser source in OBS. They live next to the other local
// state (git-ignored, excluded from the image), readable only by this user where the OS allows.
// "Replace overlay link" still rotates the overlay link, and the new one is saved.
import { randomBytes } from 'node:crypto';
import { existsSync, readFileSync, renameSync, writeFileSync } from 'node:fs';
import { DEFAULT_STYLE, DisplayStyleSchema, type DisplayStyle } from '../shared/contracts';

export type LocalLinks = { owner: string; view: string; style?: DisplayStyle };

const token = (bytes: number) => randomBytes(bytes).toString('base64url');
const valid = (t: unknown, min: number): t is string => typeof t === 'string' && /^[A-Za-z0-9_-]+$/.test(t) && t.length >= min;

export function localLinks(file: string): { links: LocalLinks; saveView: (view: string) => void; saveStyle: (style: DisplayStyle) => void } {
  let links: LocalLinks | null = null;
  if (existsSync(file)) {
    try {
      const j = JSON.parse(readFileSync(file, 'utf8')) as Partial<LocalLinks>;
      if (valid(j.owner, 32) && valid(j.view, 24)) {
        links = { owner: j.owner, view: j.view };
        const saved = DisplayStyleSchema.safeParse({ ...DEFAULT_STYLE, ...j.style });
        if (j.style && saved.success) links.style = saved.data;
      }
    } catch {
      links = null;
    }
  }
  // Frequent slider adjustments must not leave half-written capabilities if the process stops.
  const write = (l: LocalLinks) => {
    const temporary = `${file}.${process.pid}.tmp`;
    writeFileSync(temporary, JSON.stringify(l), { mode: 0o600 });
    renameSync(temporary, file);
  };
  if (!links) {
    links = { owner: token(24), view: token(18) };
    write(links);
  }
  const current = links;
  return {
    links: current,
    saveView: (view) => {
      current.view = view;
      write(current);
    },
    saveStyle: (style) => {
      current.style = DisplayStyleSchema.parse(style);
      write(current);
    },
  };
}
