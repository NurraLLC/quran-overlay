import { DatabaseSync } from 'node:sqlite';

// Hosted overlay links that outlive sessions. A streamer pastes their overlay link into OBS once; a
// session is dropped after idle time and every restart or deploy starts afresh, so without this the
// link stopped working and the streamer's chosen look was forgotten. Per visitor: the view token,
// the display style and a charity stream's settings and donations (names as the streamer entered
// them, as shown on their stream). Nothing about what was recited.
const KEEP_MS = 180 * 24 * 3600_000;

export class OverlayLinks {
  private db: DatabaseSync;
  constructor(file: string, now = Date.now()) {
    this.db = new DatabaseSync(file);
    this.db.exec('CREATE TABLE IF NOT EXISTS overlay_links (visitor TEXT PRIMARY KEY, view TEXT NOT NULL UNIQUE, style TEXT, seen INTEGER NOT NULL)');
    const cols = this.db.prepare('PRAGMA table_info(overlay_links)').all() as Array<{ name: string }>;
    if (!cols.some((c) => c.name === 'stream')) this.db.exec('ALTER TABLE overlay_links ADD COLUMN stream TEXT');
    // Links unused for half a year are forgotten (their visitors' cookies have expired too).
    this.db.prepare('DELETE FROM overlay_links WHERE seen < ?').run(now - KEEP_MS);
  }

  /** The visitor's saved link, or null. Marks it as in use. */
  get(visitor: string, now = Date.now()): { view: string; style: unknown; stream: unknown } | null {
    const r = this.db.prepare('SELECT view, style, stream FROM overlay_links WHERE visitor = ?').get(visitor) as { view: string; style: string | null; stream: string | null } | undefined;
    if (!r) return null;
    this.db.prepare('UPDATE overlay_links SET seen = ? WHERE visitor = ?').run(now, visitor);
    const parse = (s: string | null): unknown => {
      try {
        return s ? JSON.parse(s) : null;
      } catch {
        return null;
      }
    };
    return { view: r.view, style: parse(r.style), stream: parse(r.stream) };
  }

  /** Whose overlay link this is (an OBS source reconnecting after its session was dropped). */
  visitorOf(view: string): string | null {
    const r = this.db.prepare('SELECT visitor FROM overlay_links WHERE view = ?').get(view) as { visitor: string } | undefined;
    return r?.visitor ?? null;
  }

  saveView(visitor: string, view: string, now = Date.now()) {
    this.db.prepare('INSERT INTO overlay_links (visitor, view, style, seen) VALUES (?, ?, NULL, ?) ON CONFLICT(visitor) DO UPDATE SET view = excluded.view, seen = excluded.seen').run(visitor, view, now);
  }

  saveStyle(visitor: string, style: unknown, now = Date.now()) {
    this.db.prepare('UPDATE overlay_links SET style = ?, seen = ? WHERE visitor = ?').run(JSON.stringify(style), now, visitor);
  }

  saveStream(visitor: string, stream: unknown, now = Date.now()) {
    this.db.prepare('UPDATE overlay_links SET stream = ?, seen = ? WHERE visitor = ?').run(JSON.stringify(stream), now, visitor);
  }

  close() {
    this.db.close();
  }
}
