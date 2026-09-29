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

export type Pack = { id: string; hours: number; label: string; price: string };
export type PoolStats = {
  given: number;
  used: number;
  left: number;
  givenThisMonth: number;
  giftsThisMonth: number;
  lastGiftAt: number | null;
  recitersThisWeek: number;
  recitedThisWeek: number;
  goalThisMonth: number;
};
/** A donation to the shared sponsored-listening pool, and the hours it adds. */
export type Donation = { amountCents: number; price: string; hours: number };
export type Access = {
  mode: 'local' | 'hosted';
  owner: boolean;
  credits?: import('../shared/contracts').CreditView;
  /** Hosted: the visitor's own code for keeping their time on another device. */
  recoveryCode?: string | null;
  /** Hosted with payments on: what can be bought. */
  billing?: { packs: Pack[]; donations?: Donation[] } | null;
  /** Hosted: the shared pool's story (seconds, counts; totals only). */
  sponsored?: PoolStats;
};

/** Local: trade the owner link for the cookie. Hosted: get (or be issued) this visitor's identity. */
export async function access(): Promise<Access> {
  await exchangeOwner();
  const r = await fetch('/api/me', { credentials: 'same-origin' });
  return (await r.json()) as Access;
}

/** The one-line listening status: free and shared, or the personal allowance when one is configured. */
export function listeningLine(c: import('../shared/contracts').CreditView): string {
  if (c.freePerMonth > 0) return c.available > 0 ? `${formatListening(c.available)} of listening left` : 'No listening time left';
  if (c.limitedBy === 'pool') return 'Shared hours have run out · sponsor more';
  if (c.limitedBy === 'share') return "Today's share recited · back tomorrow";
  return `Free · ${Math.round(c.pool / 3600).toLocaleString()} h shared right now`;
}

/** "9 h 41 min", "12 min", "under a minute". */
export function formatListening(seconds: number): string {
  const s = Math.max(0, Math.floor(seconds));
  if (s < 60) return 'under a minute';
  const h = Math.floor(s / 3600);
  const m = Math.floor((s % 3600) / 60);
  return h ? `${h} h${m ? ` ${m} min` : ''}` : `${m} min`;
}
