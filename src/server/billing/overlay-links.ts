import { DatabaseSync } from 'node:sqlite';

// Hosted overlay links that outlive sessions. A streamer pastes their overlay link into OBS once; a
// session is dropped after idle time and every restart or deploy starts afresh, so without this the
// link stopped working and the streamer's chosen look was forgotten. Per visitor: the view token
// and the display style. Nothing about what was recited.
const KEEP_MS = 180 * 24 * 3600_000;

export class OverlayLinks {
  private db: DatabaseSync;
  constructor(file: string, now = Date.now()) {
    this.db = new DatabaseSync(file);
    this.db.exec('CREATE TABLE IF NOT EXISTS overlay_links (visitor TEXT PRIMARY KEY, view TEXT NOT NULL UNIQUE, style TEXT, seen INTEGER NOT NULL)');
    // Links unused for half a year are forgotten (their visitors' cookies have expired too).
    this.db.prepare('DELETE FROM overlay_links WHERE seen < ?').run(now - KEEP_MS);
  }

  /** The visitor's saved link, or null. Marks it as in use. */
  get(visitor: string, now = Date.now()): { view: string; style: unknown } | null {
    const r = this.db.prepare('SELECT view, style FROM overlay_links WHERE visitor = ?').get(visitor) as { view: string; style: string | null } | undefined;
    if (!r) return null;
    this.db.prepare('UPDATE overlay_links SET seen = ? WHERE visitor = ?').run(now, visitor);
    let style: unknown = null;
    try {
      style = r.style ? JSON.parse(r.style) : null;
    } catch {
      style = null;
    }
    return { view: r.view, style };
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

  close() {
    this.db.close();
  }
}
