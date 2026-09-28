// Soniox temporary-key minting only. The long-lived key never leaves this process; the browser
// receives a single-use key that can open exactly one realtime stream shortly after issue.
// POST https://api.soniox.com/v1/auth/temporary-api-key (see work/research Soniox snapshot).

export const SONIOX_KEY_URL = 'https://api.soniox.com/v1/auth/temporary-api-key';
/** Explicit per-stream cap below the provider's fixed 300-minute limit; the client restarts before it. */
export const STREAM_CAP_SECONDS = 3 * 60 * 60;

export type TemporaryKey = { api_key: string; expires_at: string };

export class SonioxKeyError extends Error {
  constructor(readonly code: 'NOT_CONFIGURED' | 'AUTHENTICATION_FAILED' | 'RATE_LIMITED' | 'SERVICE_UNAVAILABLE' | 'REQUEST_REJECTED' | 'TRANSPORT_UNAVAILABLE' | 'RESPONSE_INVALID') {
    super(code);
  }
}

export async function mintTemporaryKey(apiKey: string | undefined, clientReference: string, fetchImpl: typeof fetch = fetch): Promise<TemporaryKey> {
  if (!apiKey) throw new SonioxKeyError('NOT_CONFIGURED');
  let res: Response;
  try {
    res = await fetchImpl(SONIOX_KEY_URL, {
      method: 'POST',
      headers: { Authorization: `Bearer ${apiKey}`, 'Content-Type': 'application/json' },
      body: JSON.stringify({
        usage_type: 'transcribe_websocket',
        expires_in_seconds: 60,
        single_use: true,
        max_session_duration_seconds: STREAM_CAP_SECONDS,
        client_reference_id: clientReference.slice(0, 256),
      }),
      redirect: 'manual',
      signal: AbortSignal.timeout(5000),
    });
  } catch {
    throw new SonioxKeyError('TRANSPORT_UNAVAILABLE');
  }
  if (res.status === 401 || res.status === 403) throw new SonioxKeyError('AUTHENTICATION_FAILED');
  if (res.status === 429) throw new SonioxKeyError('RATE_LIMITED');
  if (res.status >= 500) throw new SonioxKeyError('SERVICE_UNAVAILABLE');
  if (res.status !== 201 && res.status !== 200) throw new SonioxKeyError('REQUEST_REJECTED');
  let body: unknown;
  try {
    body = await res.json();
  } catch {
    throw new SonioxKeyError('RESPONSE_INVALID');
  }
  const b = body as Partial<TemporaryKey>;
  if (typeof b.api_key !== 'string' || !b.api_key || typeof b.expires_at !== 'string') throw new SonioxKeyError('RESPONSE_INVALID');
  return { api_key: b.api_key, expires_at: b.expires_at };
}
