import { DatabaseSync } from 'node:sqlite';

// Persistent, private counters. Never store audio, recognised words, or donor names.
export const IDLE_LIMIT_MS = 90_000;
const WINDOW_MS = 15 * 60_000;
const COOLDOWN_MS = 5 * 60_000;
type Row = { subject: string; started: number; idle_ms: number; strikes: number; blocked_until: number };

export class ListeningSafety {
  private db: DatabaseSync;
  constructor(file: string) {
    this.db = new DatabaseSync(file);
    this.db.exec('CREATE TABLE IF NOT EXISTS listening_safety (subject TEXT PRIMARY KEY, started INTEGER NOT NULL, idle_ms INTEGER NOT NULL DEFAULT 0, strikes INTEGER NOT NULL DEFAULT 0, blocked_until INTEGER NOT NULL DEFAULT 0)');
  }
  private row(subject: string, now: number): Row {
    const r = this.db.prepare('SELECT * FROM listening_safety WHERE subject = ?').get(subject) as Row | undefined;
    if (!r || (now >= r.blocked_until && now - r.started >= WINDOW_MS)) return { subject, started: now, idle_ms: 0, strikes: 0, blocked_until: 0 };
    if (r.blocked_until && now >= r.blocked_until) return { ...r, idle_ms: 0, blocked_until: 0 };
    return r;
  }
  private put(r: Row) {
    this.db.prepare('INSERT OR REPLACE INTO listening_safety VALUES (?, ?, ?, ?, ?)').run(r.subject, r.started, r.idle_ms, r.strikes, r.blocked_until);
  }
  status(id: string, ip: string, now = Date.now()) {
    const user = this.row(`u:${id}`, now);
    const network = this.row(`n:${ip}`, now);
    return { retryAfter: Math.max(0, Math.ceil((Math.max(user.blocked_until, network.blocked_until) - now) / 1000)), idleMs: user.idle_ms };
  }
  // Called only from the server-owned audio connection, never from a client capture message.
  record(id: string, ip: string, idleMs: number, heardRecitation: boolean, now = Date.now()) {
    const user = this.row(`u:${id}`, now);
    user.idle_ms = Math.max(0, Math.round((heardRecitation ? 0 : user.idle_ms) + idleMs));
    if (user.idle_ms >= IDLE_LIMIT_MS) {
      user.strikes++;
      user.blocked_until = now + COOLDOWN_MS;
      const network = this.row(`n:${ip}`, now);
      network.strikes++;
      if (network.strikes >= 8) network.blocked_until = now + COOLDOWN_MS;
      this.put(network);
    }
    this.put(user);
    // Bound retention of inactive counters, independently of browser cookies.
    this.db.prepare('DELETE FROM listening_safety WHERE started < ? AND blocked_until < ?').run(now - 30 * 86_400_000, now);
  }
  close() { this.db.close(); }
}
