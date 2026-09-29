// Serves Quran Reader at nurra.org/quran-reader from its own server, while the rest of nurra.org
// stays on the main site. Add this as a Cloudflare Worker with the route  nurra.org/quran-reader*
// and set ORIGIN (a Worker variable) to the Quran Reader server's own name, e.g.
// reader-origin.nurra.org (see docs/DEPLOY.md). WebSockets pass through unchanged.
export default {
  async fetch(request, env) {
    const url = new URL(request.url);
    url.hostname = env.ORIGIN;
    const headers = new Headers(request.headers);
    // The visitor's real address, set here so a visitor cannot choose it (per-network daily limits).
    headers.set('X-Forwarded-For', request.headers.get('CF-Connecting-IP') ?? '');
    return fetch(new Request(url, { method: request.method, headers, body: request.body, redirect: 'manual' }));
  },
};
