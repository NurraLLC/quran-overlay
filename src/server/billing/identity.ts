// Anonymous visitor identity for the hosted service: a random id in an HttpOnly cookie, signed so it
// cannot be forged or guessed. No personal data; an account system can later attach to the same id.

import { createHmac, randomBytes, timingSafeEqual } from 'node:crypto';
import { existsSync, mkdirSync, readFileSync, writeFileSync } from 'node:fs';
import path from 'node:path';

export class VisitorIdentity {
  constructor(private readonly secret: Buffer) {
    if (secret.length < 32) throw new Error('identity secret must be at least 32 bytes');
  }

  /** The signing secret persists across restarts (so visitors keep their credits). */
  static fromFile(file: string, envSecret?: string): VisitorIdentity {
    if (envSecret) return new VisitorIdentity(Buffer.from(envSecret, 'utf8'));
    if (existsSync(file)) return new VisitorIdentity(readFileSync(file));
    mkdirSync(path.dirname(file), { recursive: true });
    const secret = randomBytes(48);
    writeFileSync(file, secret, { mode: 0o600 });
    return new VisitorIdentity(secret);
  }

  private sign(id: string) {
    return createHmac('sha256', this.secret).update(id).digest('base64url');
  }

  issue(): { id: string; cookie: string } {
    const id = randomBytes(16).toString('base64url');
    return { id, cookie: `${id}.${this.sign(id)}` };
  }

  /** The visitor id in a cookie value, or null if it is missing, malformed or not ours. */
  verify(cookie: string | null): string | null {
    if (!cookie) return null;
    const dot = cookie.indexOf('.');
    if (dot <= 0) return null;
    const id = cookie.slice(0, dot);
    const sig = Buffer.from(cookie.slice(dot + 1));
    const want = Buffer.from(this.sign(id));
    return sig.length === want.length && timingSafeEqual(sig, want) && /^[A-Za-z0-9_-]{16,64}$/.test(id) ? id : null;
  }
}
