# Launch handoff

State on 2026-09-29, for whoever takes the hosted site live (Codex or a person). Read [DEPLOY.md](DEPLOY.md) for the full reference; this page is the short path and what is and is not verified.

## Where things stand

- Code: public at https://github.com/NurraLLC/quran-overlay (`main`), MIT. CI (typecheck, 174 tests, build, corpus fetch and validation) passes.
- Local use and streaming work now: `npm start`, open the printed control link, copy the OBS overlay link. Self-hosted links survive restarts (`data/state/local-links.json`).
- Hosted mode (`QO_HOSTED=1`) was run locally and walked through as a visitor: reader home page, listening-time credits, streamer link to the control page, link-preview card.
- Latest owner live session (Ya-Sin, Al-Baqarah, Ar-Rahman) found three problems; all fixed and verified by replaying its capture, not yet by a new live session: going back a few words after a breath, the highlight blinking on elongated words, and "go to Surah Rahman" arriving in Arabic script.

## Not yet verified (do these first)

1. **The Docker image has never been built.** Docker was not available on the development machine. `deploy/compose.yml` and `deploy/Caddyfile` were checked for syntax only; the image runs the same steps CI runs.
2. **OBS itself.** The overlay is the page verified in Edge; not yet loaded as an OBS browser source.
3. **A fresh live recitation test** of today's fixes (the owner does this; do not generate recitation with TTS).

## Go live

Needs from the owner (do not create accounts or handle their passwords):

- A small Linux server with Docker (1 vCPU, 1–2 GB memory is plenty: the app uses about 280 MB; audio never touches the server).
- Where it will live. Planned: **nurra.org/quran-reader** (see *At nurra.org/quran-reader* in DEPLOY.md: a server name such as reader-origin.nurra.org, and a Cloudflare Worker route). A subdomain such as quran.nurra.org also works and needs no Worker.
- A Soniox API key and an OpenRouter API key made for the site, each with a spending limit set in that provider's dashboard.

Then, on the server:

```bash
git clone https://github.com/NurraLLC/quran-overlay.git && cd quran-overlay
```

```bash
cp deploy/production.env.example deploy/production.env
```

Fill in `deploy/production.env` (domain, keys; keep the conservative `QO_FREE_HOURS_PER_SERVICE_DAY`), then:

```bash
docker compose -f deploy/compose.yml --env-file deploy/production.env up -d --build
```

Then fill the shared hours (listening is free for everyone from this pool; nothing is spent that was not put in):

```bash
docker compose -f deploy/compose.yml --env-file deploy/production.env exec app npx tsx scripts/sponsor-pool.ts 100 launch
```

## Check after deploy

- `https://<domain>/healthz` returns `{"ok":true}`.
- The home page loads over HTTPS, the microphone prompt appears when tapping the mic, and the listening-time line shows the free allowance.
- Typed requests work without the microphone: `2:255`, `surah about elephants`, `Ar-Rahman`.
- Menu → Put it on your stream → Copy OBS overlay link; the link opens and shows the ayah on screen.
- Sharing the URL shows the preview card (the image address must be `https://<domain>/og.png`).
- `docker compose ... logs app` shows the start banner with `Hosted mode` and no errors.
- Back up the `qo-state` volume (credit ledger and visitor-signing secret).

## Monthly cost

| Item | Cost |
|---|---|
| Server (small VM) | about $4–6 |
| Domain | $0 on a subdomain you own; otherwise about $1 a month |
| GitHub, CI | $0 (public repository) |
| Speech recognition (Soniox, $0.12 per hour a stream is open, pauses included) | the only real variable; see below. The silence skipper closes the stream after 8 s without voice: about 11% of recorded listening time, plus the silent minute before listening stops by itself |
| Spoken requests and meaning search (JEV via OpenRouter, about $0.000015 each) | cents: 10,000 requests ≈ $0.15 |
| Payments (Stripe) | nothing unless something is sold or given (their per-payment fee) |

Listening is the only cost that grows with use, and `QO_FREE_HOURS_PER_SERVICE_DAY` caps it: 25 hours a day (the template's value) is at most about $3 a day, $90 a month, and only if the site is used that much every day. Realistic early use is far below: 50 people listening 2 hours a month each is 100 hours, $12. Reading, search and the overlay cost nothing per use. Expect roughly **$5–20 a month** at launch, with a hard ceiling you choose.

Funding free listening: hour packs ($5 for 20 h leaves about $2.35 after costs) and donations to the shared sponsored pool (at cost: $10 adds about 76 hours anyone can recite from once their own time runs out). The site's `/about` page explains this to visitors, with the Islamic texts on the reward of such giving (only sahih and hasan narrations, linked to sunnah.com).

## Rules that still apply

- Never commit or print keys, `deploy/production.env`, `.env`, captures or `data/state`.
- Do not enable payments until Quran Foundation has confirmed paid use (developers@quran.com); the site launches free.
- Zero wrong ayahs on screen is the floor. Tracker changes are checked with `npm test`, `npx tsx scripts/replay-session.ts fixtures/scenarios fixtures/scenarios-derived data/captures --one` (wrong must stay 0) and the browser tests (`npm run test:ui`, which starts its own server on port 4399).
