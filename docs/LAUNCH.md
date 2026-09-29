# Launch handoff

For whoever takes the site live (Codex or a person). State on 2026-09-29. [DEPLOY.md](DEPLOY.md) is the full reference; this page is the short path, what is verified, and what is not.

The subsequent [final review](FINAL_REVIEW.md) records launch fixes and fresh local evidence: 192 unit/integration tests, nine browser tests, corpus validation and the 805-ayah replay. The historical verification below predates those fixes; check CI on the final commit before deploying.

## What is being launched

**Quran Reader**, a Nurra project, at **https://nurra.org/quran-reader/**. Code: https://github.com/NurraLLC/quran-reader (public, MIT; `main`).

- The start page is a phone-friendly reader: recite and the page follows along, each word with its meaning. The control page (`/quran-reader/control`) drives the OBS overlay for streamers.
- Listening is **free for everyone**, paid for by sadaqah: one pool of sponsored hours that donations (and Nurra) fill. Each person may recite 2 hours a day, each network 4. When shared hours are unavailable, new listening pauses and the page says so; reading and search continue. The pool limits listening admission; it is not a guarantee of the dollar bill (see *Monthly cost*).
- `/quran-reader/about` ("Why we built this") explains the costs, where sadaqah goes, and the reward of giving (Quran 2:261 and four sahih/hasan narrations, linked to sunnah.com).

## Verified

- CI: typecheck, 189 unit tests, build, and corpus fetch with validation all pass. Six browser tests pass locally (`npm run test:ui`): control page, reading screen, reader menu and following, the "Why we built this" page, live word following, and the silence skipper.
- Tracking: replaying every recorded session and scenario (105 files, 805 ayahs) shows 0 wrong ayahs and 0 blank screens.
- The hosted site under `/quran-reader`, run locally in a browser: every request stayed under the prefix (font, scripts, API, live connection, links), and the OBS link and share card carry it.
- Silence skipper: a real browser with a fake microphone (tone, 11 s of silence, tone) and a stand-in provider. The stream closed after 8 s of silence and reopened when the voice returned.
- Donations and packs: tested against a mocked Stripe (signed webhooks, one grant per payment, tampered amounts rejected). They have never run against real Stripe.

## Not verified yet (do these first)

1. **The Docker image has never been built.** Docker was not available on the development machine. `deploy/compose.yml` and `deploy/Caddyfile` were only checked for syntax; the image runs the same steps CI runs.
2. **The Cloudflare Worker has never run.** Check that the live connection (WebSocket) works through it: opening a surah from the list uses it.
3. **Stripe for real.** Use test mode first. Live keys only after Quran Foundation confirms (below).
4. **OBS.** The overlay is the page verified in Edge; it has not been loaded as an OBS browser source.
5. **Live recitation by the owner.** Today's tracker fixes and the silence skipper have not had a live session yet. Do not generate recitation with TTS; the owner tests by reciting.

## What the owner provides

The owner completes sign-up, passwords and payment details. Open the relevant provider pages for them when needed.

- A small Linux server with Docker (1 vCPU and 1–2 GB of memory is plenty; audio never touches the server).
- A DNS name for that server, e.g. `reader-origin.nurra.org` (an A record to the server).
- Access to nurra.org's Cloudflare, to add the Worker and its route.
- A Soniox API key and an OpenRouter API key made for the site, each with a spending limit set in that provider's dashboard.
- The hours to start the pool with (100 hours is $12 of recognition).
- Later, for donations: Stripe keys (test mode first).

## Steps

On the server:

```bash
git clone https://github.com/NurraLLC/quran-reader.git && cd quran-reader
```

```bash
cp deploy/production.env.example deploy/production.env
```

In `deploy/production.env`, set the keys and these values for nurra.org:

```
QO_DOMAIN=reader-origin.nurra.org
QO_PUBLIC_ORIGIN=https://nurra.org
QO_BASE_PATH=/quran-reader
QO_EXTRA_HOSTS=reader-origin.nurra.org
```

Start the app and Caddy (the HTTPS certificate for `reader-origin.nurra.org` is obtained automatically):

```bash
docker compose -f deploy/compose.yml --env-file deploy/production.env up -d --build
```

Fill the pool:

```bash
docker compose -f deploy/compose.yml --env-file deploy/production.env exec app npx tsx scripts/sponsor-pool.ts 100 launch
```

In Cloudflare, create a Worker from [deploy/cloudflare-worker.js](../deploy/cloudflare-worker.js), give it the variable `ORIGIN` = `reader-origin.nurra.org`, and add the route `nurra.org/quran-reader*`.

Later, for donations: in Stripe (test mode first), add the webhook `https://nurra.org/quran-reader/api/billing/webhook` for `checkout.session.completed` and `checkout.session.async_payment_succeeded`, then set `STRIPE_SECRET_KEY` and `STRIPE_WEBHOOK_SECRET` and run the same `up` command again.

## Check after deploy

- `https://reader-origin.nurra.org/healthz` returns `{"ok":true}`.
- `https://nurra.org/quran-reader/` loads. In the browser's network tab every request stays under `/quran-reader/` with no 404s, and the Arabic shows in the Uthmani font.
- The sponsored bar shows the hours you added ("100 hours of recitation sponsored").
- Opening a surah from the list works (this uses the live connection through the Worker).
- Verify network limits from two distinct networks; Caddy must forward the visitor address, not a shared Cloudflare address. Validate the supplied Caddyfile before starting the proxy (`docker compose ... run --rm caddy caddy validate --config /etc/caddy/Caddyfile`).
- The microphone: allow it and recite, and the page follows. After 8 seconds of silence the status reads "Listening… take your time", and it continues when you recite again.
- Typed requests work: `2:255`, `surah about elephants`, `Ar-Rahman`.
- Control page → Copy OBS overlay link: it starts with `https://nurra.org/quran-reader/overlay` and shows the ayah.
- A shared link shows the preview card (image `https://nurra.org/quran-reader/og.png`).
- `docker compose ... logs app` shows `Hosted mode` and no errors. (Its `Sponsored listening` line is written at start, so it shows the pool as it was then; the site's bar is live.)
- Back up the `qo-state` volume. It holds the pool and the visitor-signing secret.

## Monthly cost

| Item | Cost |
|---|---|
| Listening (Soniox, about $0.12 per hour) | 100 hours is approximately $12; actual token usage, context and overlapping streams can change the bill. The silence skipper closes the stream during pauses longer than 8 s. |
| Server | about $4–6 |
| Domain | $0 (nurra.org) |
| GitHub, CI | $0 (public repository) |
| Spoken requests and meaning search (JEV via OpenRouter, about $0.000015 each) | cents |
| Stripe | its per-payment fee on donations only |

Expect about $5–20 a month at launch. For scale: someone reciting 2 hours every day uses about $7 of recognition a month.

These are planning estimates, not a spending guarantee. [Soniox bills by tokens](https://soniox.com/pricing). The server cannot verify that a direct browser-to-provider stream really ended when the client reports a stop. Verify provider-side spending controls before public use; keep automatic top-ups off if a fixed budget is required. JEV requests and server hosting are separate costs. Use one app instance and persistent storage for `data/state`; a disposable free-host filesystem can erase the pool and visitor identities.

## Rules that still apply

- Never commit or print keys, `deploy/production.env`, `.env`, captures or `data/state`. Do not stage `AGENTS.md`, `CLAUDE.md` or `outputs/`.
- Donations and payments go live only after Quran Foundation confirms the use of its content (developers@quran.com). Use Stripe test mode until then.
- Zero wrong ayahs on screen is the floor. Tracker changes are checked with `npm test`, with `npx tsx scripts/replay-session.ts fixtures/scenarios fixtures/scenarios-derived data/captures --one` (wrong must stay 0), and with `npm run test:ui` (its own server on port 4399).
- Words on the site are written for people: sadaqah, tilawah, ayah, ahadith, the Prophet ﷺ; no invented terms, and no promises of reward on Allah's behalf.
- The Nurra mark is the current wordmark (from nurra-mobile, `NurraWordmarkFinal`), already in `src/web/Nurra.tsx`. Not the older Britannic Bold one in nurra-web.
