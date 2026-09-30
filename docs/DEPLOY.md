# Deploying the hosted service

The same code runs two ways:

| | Self-hosted (default) | Hosted (`QO_HOSTED=1`) |
|---|---|---|
| Who uses it | You, on your own computer | Anyone who opens the site |
| Access | Private owner link printed at start | Anonymous visitor cookie, no sign-up |
| Listening | Unlimited (your own Soniox key) | Free for everyone from a pool of sponsored hours that donations fill (2 h a day each; no daily limit while live on stream) |
| Home page | Control page | Phone-friendly reader |

Reading, search and the Quran text are free in both. Only live listening costs anything, because speech recognition is billed for as long as a stream is open.

## What it costs to run

Soniox advertises real-time recognition at **about $0.12 per hour**, with the actual bill calculated from audio, context and output tokens ([pricing](https://soniox.com/pricing), checked 2026-09-29). The app closes the stream after 8 s without voice. A JEV decision through OpenRouter was about **$0.000015** in the earlier provider check. Hosted audio passes through the app's bounded WebSocket relay to Soniox; no audio is recorded. Provider keys remain on the server.

The pool limits admission in listening seconds, **not dollars billed by providers**. The relay closes the upstream before settling time; a browser's fake stop message cannot refund an active stream. Token usage still determines the provider bill. Set and verify provider-side spending controls before public use. Hosting, relay bandwidth and JEV requests are separate costs. Run one app instance with persistent storage; sessions and reservations are not designed for multiple replicas.

## Quickest: one server, one command

On a Linux server with Docker and persistent storage (start with 1–2 GB memory, then measure load and relay bandwidth):

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
| `QO_TRUST_PROXY` | `1` behind a proxy | Take the visitor address from `X-Forwarded-For` (per-network daily share). Without it every visitor shares the proxy's address; the server warns once at the first proxied request |
| `QO_MAX_LISTENERS` | no | People reciting at once (default 60). Keep it at or below your Soniox concurrency limit (10 unless raised in the Soniox Console) and what the server's CPU carries (see *Capacity*); beyond it people wait in line, and listening starts by itself when a place frees |
| `QO_HOST` | `0.0.0.0` in a container | Listen address (default loopback) |
| `PORT` | no | Default 4317 |
| `QO_SECRET` | no | Visitor-cookie signing secret (48+ random bytes); otherwise generated into the state volume |
| `QO_STATE_DIR` | no | Where credits and the secret live (default `data/state`) |
| `STRIPE_SECRET_KEY`, `STRIPE_WEBHOOK_SECRET` | no | Turn on donations (sadaqah into the pool) |
| `QO_SPONSORED_HOURS_PER_VISITOR_DAY` | no | Each person's daily share of the shared hours (default 2) |
| `QO_SPONSORED_HOURS_PER_NETWORK_DAY` | no | A network's daily share across its visitors (default 4) |
| `QO_DONATIONS` | no | Donation amounts in cents (default `[500,1000,2500]`) |
| `QO_SPONSOR_CENTS_PER_HOUR` | no | Estimated donation conversion, default 13 cents per hour; verify it against actual recognition costs and fees |

Keep `data/state` on a persistent volume and back it up: it holds the pool, the listening ledger, safety counters and the anonymous visitor-cookie signing secret. These are operational records, not user accounts. The site has no sign-up, personal plans or recovery codes.

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

Listening is free for everyone from one shared pool of hours. Gifts add hours at the configured conversion (`QO_SPONSOR_CENTS_PER_HOUR`, so $10 adds 76 hours at the default 13 cents). This conversion is an estimate, not a guarantee that every payment fee and provider charge is covered. Daily visitor/network limits protect fair access; when shared hours are unavailable, reading and translations continue. Outstanding streams reserve time before another visitor can draw it. The start page shows lifetime hours funded, used and remaining, with no monthly goal, donor names or leaderboard. Donations need Stripe (below). **Fill the pool at launch**, and add hours by hand any time:

```bash
npm run pool:add -- 50 masjid-gift
```

In Docker: `docker compose -f deploy/compose.yml --env-file deploy/production.env exec app npx tsx scripts/sponsor-pool.ts 50 masjid-gift`.

### Live streams

A visitor whose overlay link is open (in OBS, or as a reading screen) is **live on stream**, and a broadcast is not cut short: a 24-hour charity stream runs the whole day. While live:

- **No daily limit.** The visitor and network daily shares do not apply; the time still comes from the pool (so it is recorded), and an empty pool still pauses listening for everyone. A 24-hour stream uses at most 24 of the pool's hours (about $2.90 of recognition), usually less: silences are not sent.
- **No idle stop.** Breaks and talk with the audience never stop listening (silence costs nothing; talk is recognised, so billed).
- **The place is kept.** When listening is full, a live stream keeps its place through breaks of up to 30 minutes while its listening is on, and goes to the front of the line otherwise.
- **Connections come back.** A lost connection (the network, a server restart or deploy) is retried by the page every few seconds until it is back, instead of stopping.

At most three live streams per network have these rules at once (a household, a masjid); more have the usual limits. The page shows "Live on stream · no time limit". Before a long stream, check the pool and the Soniox balance (turn on its auto top-up), and avoid deploying during it: listening reconnects by itself, but a restart interrupts following for the seconds it takes. Donations for another organization go through that organization's own link, separate from this pool (see *Payments*).

## Payments (optional)

Hosted audio uses `/ws/speech` as well as `/ws/control`. Both must pass through your proxy. One stream per visitor is allowed. The server rejects client-selected provider models/context, oversized/backlogged audio, and audio processed substantially faster than real time. Ninety seconds of connected time without recognised Quran phrases, accumulated across restarts, pauses listening for five minutes. Eight such cutoffs from a network in fifteen minutes trigger a five-minute network pause. Safety counters persist in `data/state/listening-safety.db`; no audio or recognised text is stored there. Normal silence skipping is still local and closes the relay early. This heuristic can miss or misrecognise speech; it is not a recitation grade, identity check or permanent ban. Live latency of the relay must be measured before claiming the old direct-stream timings.

1. In the Stripe dashboard, add a webhook endpoint for `checkout.session.completed` and `checkout.session.async_payment_succeeded` at `https://<public origin><base path>/api/billing/webhook` (for nurra.org: `https://nurra.org/quran-reader/api/billing/webhook`).
2. Set `STRIPE_SECRET_KEY` and that endpoint's `STRIPE_WEBHOOK_SECRET`. Use test-mode keys first; Stripe's test cards complete a real flow without charging anyone.
3. Contributions are Stripe Checkout line items created per payment; no products need to exist in Stripe. The public action is **Support Quran Reader**. Checkout identifies Nurra LLC, the shared hours added, and that contributions are not tax-deductible charitable donations.

Contributions add to the shared pool for everyone. No app account is needed. Use Nurra LLC's verified Stripe business details and a business bank account for payouts. The support entry stays visible without keys, but explains that online contributions are not open; it never fabricates an active checkout. Test a completed payment, cancellation, declined payment, and duplicate webhook before enabling live checkout. A creator's fundraiser for another organization uses that organization's own payment link, separate from this pool.

## Before taking any payment (donations included)

- [Quran Foundation's developer terms](https://api-docs.quran.com/legal/developer-terms/) (checked 2026-09-29, updated 2026-09-14) explicitly allow app donations without a separate commercial licence, subject to the terms and source-specific rights. The previous blanket requirement to obtain confirmation before payments was an extra precaution, not that rule. The Saheeh International translation is published by Dar Abul-Qasim.
- Storage is a separate requirement: section 3.1 limits caching to one week unless permitted otherwise; eligible Content Sync resources require a sync at least every seven days. Public deployments use the authenticated `live` image and daily refresh described in [CONTENT_REFRESH.md](CONTENT_REFRESH.md), with a six-day freshness guard. The default bundled image is for local use and CI. Switching to QUL requires checking each resource's licence, not merely that it is downloadable.
- The KFGQPC Uthmanic Hafs font may be used and distributed free of charge; it must not be sold or modified.
- Show attribution (the app credits the translation and word-by-word source on screen).

## Health

`GET /healthz` returns `{"ok":true}`. The server writes no request logs (URLs could carry private links) and keeps no visitor transcripts in hosted mode.
