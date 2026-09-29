// Reconnecting WebSocket with bounded backoff. The server sends a full state on every (re)connect,
// so a reconnect never needs local replay.

export type Socket = {
  send(msg: unknown): boolean;
  close(): void;
};

export function connect(
  path: string,
  handlers: {
    onOpen?: (send: (m: unknown) => boolean) => void;
    onMessage: (data: unknown) => void;
    onStatus?: (s: 'connecting' | 'open' | 'closed', code?: number) => void;
    /** Return false to stop reconnecting after a close code (e.g. auth failure). */
    shouldRetry?: (code: number) => boolean;
  },
): Socket {
  let ws: WebSocket | null = null;
  let closed = false;
  let attempt = 0;
  let timer: ReturnType<typeof setTimeout> | null = null;
  const url = `${location.protocol === 'https:' ? 'wss' : 'ws'}://${location.host}${path}`;
  const send = (m: unknown) => {
    if (ws?.readyState !== WebSocket.OPEN) return false;
    ws.send(JSON.stringify(m));
    return true;
  };
  const open = () => {
    handlers.onStatus?.('connecting');
    ws = new WebSocket(url);
    ws.onopen = () => {
      attempt = 0;
      handlers.onStatus?.('open');
      handlers.onOpen?.(send);
    };
    ws.onmessage = (ev) => {
      try {
        handlers.onMessage(JSON.parse(String(ev.data)));
      } catch {
        /* malformed frame ignored */
      }
    };
    ws.onclose = (ev) => {
      handlers.onStatus?.('closed', ev.code);
      if (closed || (handlers.shouldRetry && !handlers.shouldRetry(ev.code))) return;
      const delay = Math.min(5000, 250 * 2 ** attempt++);
      timer = setTimeout(open, delay);
    };
  };
  open();
  return {
    send,
    close() {
      closed = true;
      if (timer) clearTimeout(timer);
      ws?.close();
    },
  };
}

/** Trade a one-time owner link (#owner=…) for the session cookie, and clear it from the address bar. */
export async function exchangeOwner(): Promise<void> {
  const params = new URLSearchParams(location.hash.slice(1));
  const token = params.get('owner');
  if (!token) return;
  history.replaceState(null, '', location.pathname); // capability leaves the address bar immediately
  await fetch('/api/owner/session', {
    method: 'POST',
    headers: { 'Content-Type': 'application/json' },
    body: JSON.stringify({ token }),
    credentials: 'same-origin',
  }).catch(() => undefined);
}
