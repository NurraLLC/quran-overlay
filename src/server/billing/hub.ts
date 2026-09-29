// One session per visitor (hosted mode). A session is created on first use and dropped after it has
// been idle — no open page and no microphone stream — for a while; the corpus, index, resolver and
// JEV client are shared by all sessions, so a session itself is small.

import type { Session } from '../sessions';

type Entry = { session: Session; lastSeen: number };

export class SessionHub {
  private readonly sessions = new Map<string, Entry>();

  constructor(
    private readonly create: (visitorId: string) => Session,
    private readonly idleMs = 30 * 60_000,
    private readonly maxSessions = 5000,
  ) {}

  get size() {
    return this.sessions.size;
  }

  get(visitorId: string, now = Date.now()): Session {
    let e = this.sessions.get(visitorId);
    if (!e) {
      if (this.sessions.size >= this.maxSessions) this.sweep(now, true);
      e = { session: this.create(visitorId), lastSeen: now };
      this.sessions.set(visitorId, e);
    }
    e.lastSeen = now;
    return e.session;
  }

  /** An existing session, without creating one. */
  peek(visitorId: string): Session | null {
    return this.sessions.get(visitorId)?.session ?? null;
  }

  /** The session an overlay link belongs to. */
  byView(token: string): Session | null {
    for (const e of this.sessions.values()) if (e.session.checkView(token)) return e.session;
    return null;
  }

  /** Drop idle sessions; under pressure, also the least recently seen idle ones. */
  sweep(now = Date.now(), pressure = false) {
    const idle = [...this.sessions.entries()].filter(([, e]) => e.session.controlCount === 0 && !e.session.listening);
    for (const [id, e] of idle) {
      if (now - e.lastSeen >= this.idleMs) {
        e.session.dispose();
        this.sessions.delete(id);
      }
    }
    if (pressure && this.sessions.size >= this.maxSessions) {
      const oldest = idle.filter(([id]) => this.sessions.has(id)).sort((a, b) => a[1].lastSeen - b[1].lastSeen);
      for (const [id, e] of oldest.slice(0, Math.max(1, Math.floor(this.maxSessions / 10)))) {
        e.session.dispose();
        this.sessions.delete(id);
      }
    }
  }
}
