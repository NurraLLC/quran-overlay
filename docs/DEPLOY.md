# Deploying the hosted service

The same code runs two ways:

| | Self-hosted (default) | Hosted (`QO_HOSTED=1`) |
|---|---|---|
| Who uses it | You, on your own computer | Anyone who opens the site |
| Access | Private owner link printed at start | Anonymous visitor cookie, no sign-up |
| Listening | Unlimited (your own Soniox key) | Metered in credits: free monthly allowance, optional bought time |
| Home page | Control page | Phone-friendly reader |

Reading, search and the Quran text are free in both. Only live listening is metered, because speech recognition is billed per second.

## What it costs to run

Measured on 2026-09-28: Soniox real-time recognition is **$0.12 per hour** of listening; a JEV decision through OpenRouter is about **$0.000015**. Audio goes from the browser straight to Soniox (with short-lived, time-capped keys), so the server carries no audio and a small VM is enough. The free allowances below bound what free visitors can cost you per day.

## Build and run

```bash
docker build -t quran-overlay .
```

```bash
docker run -d --name quran-overlay -p 127.0.0.1:4317:4317 -v qo-state:/app/data/state --env-file .env.production quran-overlay
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
| `QO_HOSTED` | `1` | Turn on visitors and credits |
| `QO_PUBLIC_ORIGIN` | yes, when public | e.g. `https://quran.example`; allowed Host/Origin, Secure cookies, overlay and payment links |
| `QO_TRUST_PROXY` | `1` behind a proxy | Take the visitor address from `X-Forwarded-For` (per-network free cap) |
| `QO_HOST` | `0.0.0.0` in a container | Listen address (default loopback) |
| `PORT` | no | Default 4317 |
| `QO_FREE_HOURS_PER_MONTH` | no | Free listening per visitor per month (default 10) |
| `QO_FREE_HOURS_PER_NETWORK_DAY` | no | Free listening per network per day, across visitors (default 2) |
| `QO_FREE_HOURS_PER_SERVICE_DAY` | no | Free listening for everyone per day: your spending ceiling (default 200 h, about $24) |
| `QO_SECRET` | no | Visitor-cookie signing secret (48+ random bytes); otherwise generated into the state volume |
| `QO_STATE_DIR` | no | Where credits and the secret live (default `data/state`) |
| `STRIPE_SECRET_KEY`, `STRIPE_WEBHOOK_SECRET` | no | Turn on buying listening time |
| `QO_PACKS` | no | JSON list of packs, e.g. `[{"id":"h20","hours":20,"amountCents":300,"currency":"usd","label":"20 hours of listening"}]` |

Keep `data/state` on a persistent volume and back it up: it holds the credit ledger and the visitor-signing secret (losing the secret signs every visitor out, and bought time becomes reachable only through their saved recovery codes).

## HTTPS reverse proxy

Browsers only allow the microphone on HTTPS, and the app needs WebSockets. Caddy does both with automatic certificates:

```
quran.example {
  reverse_proxy 127.0.0.1:4317
}
```

Set `QO_PUBLIC_ORIGIN=https://quran.example` and `QO_TRUST_PROXY=1`.

## Payments (optional)

1. In the Stripe dashboard, add a webhook endpoint `https://quran.example/api/billing/webhook` for `checkout.session.completed` and `checkout.session.async_payment_succeeded`.
2. Set `STRIPE_SECRET_KEY` and that endpoint's `STRIPE_WEBHOOK_SECRET`. Use test-mode keys first; Stripe's test cards complete a real flow without charging anyone.
3. Packs are Stripe Checkout line items created per purchase; no products need to exist in Stripe.

Bought time is attached to the visitor's anonymous identity. The Listening time sheet shows a recovery code that restores it on another device or after clearing cookies.

## Before charging anyone

- The corpus text and translation come from the Quran.com API. Quran Foundation's developer terms allow paid, subscription and freemium apps that only display their content in-app without reselling it; confirm your use with them (developers@quran.com) before enabling payments. The Saheeh International translation is published by Dar Abul-Qasim.
- The KFGQPC Uthmanic Hafs font may be used and distributed free of charge; it must not be sold or modified.
- Show attribution (the app credits the translation and word-by-word source on screen).

## Health

`GET /healthz` returns `{"ok":true}`. The server writes no request logs (URLs could carry private links) and keeps no visitor transcripts in hosted mode.
