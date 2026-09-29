# Deploying the hosted service

The same code runs two ways:

| | Self-hosted (default) | Hosted (`QO_HOSTED=1`) |
|---|---|---|
| Who uses it | You, on your own computer | Anyone who opens the site |
| Access | Private owner link printed at start | Anonymous visitor cookie, no sign-up |
| Listening | Unlimited (your own Soniox key) | Free for everyone from a pool of sponsored hours that donations fill (2 h a day each) |
| Home page | Control page | Phone-friendly reader |

Reading, search and the Quran text are free in both. Only live listening costs anything, because speech recognition is billed for as long as a stream is open.

## What it costs to run

Soniox advertises real-time recognition at **about $0.12 per hour**, with the actual bill calculated from audio, context and output tokens ([pricing](https://soniox.com/pricing), checked 2026-09-29). The app closes the stream after 8 s without voice. A JEV decision through OpenRouter was about **$0.000015** in the earlier provider check. Audio goes straight from the browser to Soniox using short-lived, time-capped keys.

The pool limits admission in listening seconds, **not dollars billed by providers**. Overlapping streams, token usage and client-reported early stops mean this ledger is not a provider-enforced spending ceiling. Set and verify provider-side spending controls before public use. Server costs and JEV requests are separate from the pool. Run one app instance with persistent storage; sessions and reservations are not designed for multiple replicas.

## Quickest: one server, one command

On a small Linux server with Docker (1 vCPU and 1 GB of memory is enough; audio never touches the server):

1. Point your domain's DNS A record at the server.
2. Copy the repository to the server, then `cp deploy/production.env.example deploy/production.env` and fill it in (domain, keys, daily shares).
3. Start the app and Caddy (HTTPS certificates are obtained automatically):

```bash
docker compose -f deploy/compose.yml --env-file deploy/production.env up -d --build
```

4. Open `https://your.domain/healthz`, then the site. To update later: `git pull` and run the same command.

`deploy/production.env` is git-ignored and excluded from the image; only the app container reads it. The image does not include the optional semantic-search model (`npm run search:embed`), so meaning search uses lexical matching plus JEV; everything else is the same as a local run. The credit ledger and signing secret live on the `qo-state` volume: back it up.

## Build and run

```bash
docker build -t quran-reader .
```

```bash
docker run -d --name quran-reader -p 127.0.0.1:4317:4317 -v qo-state:/app/data/state --env-file .env.production quran-reader
```

The image downloads the corpus at build time and verifies every file against the SHA-256 pinned in `corpus/sources.json` (`npm run corpus:fetch`); the build fails rather than use a changed file.

Without Docker, the same steps on any machine with Node 22.13+:

```bash
npm ci && npm run corpus:fetch && npm run corpus:import -- --manifest corpus/sources.json && npm run wbw:import && npm run build
```

```bash
QO_HOSTED=1 QO_HOST=127.0.0.1 npm start
```

## Environment

| Variable | Required | Meaning |
|---|---|---|
| `SONIOX_API_KEY` | yes | Speech recognition (server-side only; browsers get temporary keys) |
| `OPENROUTER_API_KEY` | recommended | JEV for spoken requests and meaning search (works without, with less understanding) |
| `QO_HOSTED` | `1` | Turn on visitors and sponsored listening |
| `QO_PUBLIC_ORIGIN` | yes, when public | e.g. `https://quran.example` (or `https://nurra.org` under a path); allowed Host/Origin, Secure cookies, overlay and payment links |
| `QO_BASE_PATH` | no | Serve under a path of another site, e.g. `/quran-reader` |
| `QO_EXTRA_HOSTS` | no | Extra Host names to accept, comma-separated: the name a proxy in front forwards to |
| `QO_TRUST_PROXY` | `1` behind a proxy | Take the visitor address from `X-Forwarded-For` (per-network daily share) |
| `QO_HOST` | `0.0.0.0` in a container | Listen address (default loopback) |
| `PORT` | no | Default 4317 |
| `QO_FREE_HOURS_PER_MONTH` | no | Optional personal allowance per visitor per month (default 0: everyone listens from the shared pool) |
| `QO_FREE_HOURS_PER_NETWORK_DAY`, `QO_FREE_HOURS_PER_SERVICE_DAY` | no | Caps on that optional personal allowance only (per network, and for everyone, per day) |
| `QO_SECRET` | no | Visitor-cookie signing secret (48+ random bytes); otherwise generated into the state volume |
| `QO_STATE_DIR` | no | Where credits and the secret live (default `data/state`) |
| `STRIPE_SECRET_KEY`, `STRIPE_WEBHOOK_SECRET` | no | Turn on donations (sadaqah into the pool) |
| `QO_PACKS` | no | Optional hour packs to sell (none by default), e.g. `[{"id":"h20","hours":20,"amountCents":500,"currency":"usd","label":"20 hours of listening"}]` |
| `QO_SPONSORED_HOURS_PER_VISITOR_DAY` | no | Each person's daily share of the shared hours (default 2) |
| `QO_SPONSORED_HOURS_PER_NETWORK_DAY` | no | A network's daily share across its visitors (default 4) |
| `QO_POOL_GOAL_HOURS_PER_MONTH` | no | The monthly goal the community bar shows gifts against (default 100) |
| `QO_DONATIONS` | no | Donation amounts in cents (default `[500,1000,2500]`) |
| `QO_SPONSOR_CENTS_PER_HOUR` | no | What a donated hour costs (default 13: $0.12 streamed hour plus the payment fee) |

Keep `data/state` on a persistent volume and back it up: it holds the pool, the listening ledger and the visitor-signing secret (losing the secret gives every visitor a new identity; with packs sold, bought time is then reachable only through saved recovery codes).

## At nurra.org/quran-reader

The app can live under a path of another site. nurra.org is behind Cloudflare, so Cloudflare sends
`nurra.org/quran-reader*` to the Quran Reader server and everything else to the main site. (A plain
rewrite on the main site's host is not enough if that host cannot pass WebSockets through; listening
needs them.)

1. Give the Quran Reader server its own name, e.g. `reader-origin.nurra.org` (DNS A record to the
   server), and run it as in *Quickest* with:

   ```
   QO_DOMAIN=reader-origin.nurra.org
   QO_PUBLIC_ORIGIN=https://nurra.org
   QO_BASE_PATH=/quran-reader
   QO_EXTRA_HOSTS=reader-origin.nurra.org
   ```

2. In Cloudflare, create a Worker from [deploy/cloudflare-worker.js](../deploy/cloudflare-worker.js),
   set its variable `ORIGIN` to `reader-origin.nurra.org`, and add the route `nurra.org/quran-reader*`.
   The Worker keeps the path (the app accepts it with or without the prefix), passes WebSockets
   through, and sets the visitor's real address for the per-network limits.
   The supplied Caddyfile trusts `CF-Connecting-IP` only from Cloudflare's published IP ranges
   and forwards one validated address. Keep those ranges current. If adding another proxy or
   changing hosts, verify two different networks do not accidentally share a CDN-address quota.
3. Open `https://nurra.org/quran-reader/`. The OBS link, the payment return pages and link previews
   all carry `/quran-reader`.

Every address the app gives the browser carries `QO_BASE_PATH`; it can also be served at a
domain's root (leave it empty).

## HTTPS reverse proxy

Browsers only allow the microphone on HTTPS, and the app needs WebSockets. Caddy does both with automatic certificates:

```
quran.example {
  reverse_proxy 127.0.0.1:4317
}
```

Set `QO_PUBLIC_ORIGIN=https://quran.example` and `QO_TRUST_PROXY=1`.

## Sponsored listening

Listening is free for everyone from one shared pool of hours. Gifts add hours at the configured conversion (`QO_SPONSOR_CENTS_PER_HOUR`, so $10 adds 76 hours at the default 13 cents). This conversion is an estimate, not a guarantee that every payment fee and provider charge is covered. Each person may use `QO_SPONSORED_HOURS_PER_VISITOR_DAY` a day and each network `QO_SPONSORED_HOURS_PER_NETWORK_DAY`; when no shared hours are available, new listening pauses (reading and search continue). Outstanding keys reserve shared time before another visitor can draw it. Reservations are conservative when personal credits are also configured. The start page shows pool totals, this month's gifts and recent activity (totals only). Donations need Stripe (below). **Fill the pool at launch**, and add hours by hand any time (a gift received another way, or your own funding):

```bash
npm run pool:add -- 50 masjid-gift
```

In Docker: `docker compose -f deploy/compose.yml --env-file deploy/production.env exec app npx tsx scripts/sponsor-pool.ts 50 masjid-gift`.

## Payments (optional)

1. In the Stripe dashboard, add a webhook endpoint for `checkout.session.completed` and `checkout.session.async_payment_succeeded` at `https://<public origin><base path>/api/billing/webhook` (for nurra.org: `https://nurra.org/quran-reader/api/billing/webhook`).
2. Set `STRIPE_SECRET_KEY` and that endpoint's `STRIPE_WEBHOOK_SECRET`. Use test-mode keys first; Stripe's test cards complete a real flow without charging anyone.
3. Donations (and packs, if `QO_PACKS` lists any) are Stripe Checkout line items created per payment; no products need to exist in Stripe.

Donations go into the shared pool at cost. If packs are sold, bought time is attached to the visitor's anonymous identity, and the Listening sheet shows a recovery code that restores it on another device or after clearing cookies.

## Before taking any payment (donations included)

- The corpus text and translation come from the Quran.com API. Quran Foundation's developer terms allow paid, subscription and freemium apps that only display their content in-app without reselling it; confirm your use with them (developers@quran.com) before enabling donations or payments. The Saheeh International translation is published by Dar Abul-Qasim.
- The KFGQPC Uthmanic Hafs font may be used and distributed free of charge; it must not be sold or modified.
- Show attribution (the app credits the translation and word-by-word source on screen).

## Health

`GET /healthz` returns `{"ok":true}`. The server writes no request logs (URLs could carry private links) and keeps no visitor transcripts in hosted mode.
