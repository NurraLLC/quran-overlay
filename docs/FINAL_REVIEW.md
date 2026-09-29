# Launch review — 2026-09-29

The product's useful promise is simple: open the Quran, recite, and keep your place without managing an interface. It is a free public reader, supported by voluntary community gifts. There are no reader accounts, personal purchases or monthly funding targets.

## Repaired

- The community panel shows lifetime hours funded, used for listening, and remaining. Donor names and monthly fundraising goals are absent. Signed donation webhooks add shared hours exactly once. Personal checkout/recovery routes, recovery-code UI, pack configuration and personal monthly allowances are removed from the public service. Anonymous cookies isolate reading sessions and support fair-use limits; there is no sign-up.
- Hosted audio now uses a server-owned relay. The browser receives a short-lived relay ticket, not a provider key. Only one stream per visitor can run. The server owns provider options, bounds queues and byte rates, and severs the actual upstream before settling time. Fake client stop messages cannot refund a live stream.
- After 90 seconds of connected time without recognised recitation, accumulated across restarts, listening pauses for five minutes. Eight idle cutoffs on a network in fifteen minutes temporarily pause that network. Counters survive restart and contain no audio, text or donor names. This heuristic is not a fraud verdict or recitation assessment; it cannot distinguish live recitation from a recording.

- Shared listening admission now counts other visitors' outstanding reservations against both the pool and network share. Three regression cases cover simultaneous visitors, separate cookies on one network, and failed key minting. Personal-credit reservations are intentionally conservative; run one app instance.
- The production image includes the pool-funding script used by the launch instructions. CI now builds the image, starts it, funds one hour and reads the pool back, with providers disabled.
- Caddy trusts visitor-address headers only from Cloudflare's published ranges, then sends a single validated address to the app. Otherwise the default proxy configuration groups visitors under a CDN address and applies the same network quota to them.
- About-page return links stay inside `/quran-reader/`.
- Failed first loads offer retry. Failed surah loads keep the chosen reference and offer retry. Late responses from a previous surah cannot overwrite the new selection.
- The reader explains unavailable listening and reconnecting instead of inviting taps on a disabled microphone or leaving a failed request pending.
- Donation and launch wording distinguishes listening hours from provider spending. The Quran translation is explicitly attributed separately from the paraphrased hadith translations. Startup logs describe sponsored hours instead of the retired default allowance.

## Evidence from this review

| Layer | Result |
|---|---|
| Source | TypeScript passes; 197 unit/integration tests pass; production web build passes. |
| Corpus | 25/25 checks; all 6,236 ayahs and 114 surahs retained. No scripture, font or corpus changes. |
| Browser | Ten Edge tests pass, including first-load retry, surah retry, delayed-response cancellation and community totals. The real browser SDK sends fake-device audio through the hosted relay to a stand-in provider; stopping closes it. Mock Stripe checkout and duplicate signed webhooks update the shared pool once. Hosted `/quran-reader/` inspected in the in-app browser; About links retain the prefix; phone reading, community totals and desktop overlay screenshots inspected. |
| Replay | 105 files, 805 ayahs; zero wrong ayahs and zero blank screens. The harness also reports 18 backward transitions and 70 highlight gaps. These were not individually adjudicated in this pass; do not describe this as flawless tracking. Its negative best-latency value makes the aggregate timing unsuitable for a new latency claim. |
| Proxy | Official Caddy 2.11.4 accepts the production Caddyfile locally and Caddy's container validates it in CI. A local HTTP check rejected forged visitor headers from a direct caller and forwarded a simulated trusted edge's visitor address. Live Cloudflare forwarding remains untested. |
| Container | CI passed image build, Caddy validation, startup, pool funding and readback with the hosted audio relay on `5581706`. Check later commits before deployment. |
| Provider / microphone / OBS | No new paid provider calls, owner microphone recitation, or OBS-native rendering in this review. Browser silence tests use a stand-in provider and non-recitation tone. |

## Launch dependencies

1. Server with persistent storage; Cloudflare account access and origin DNS.
2. Pass the container smoke check and verify WebSockets and distinct network quotas through Cloudflare.
3. Dedicated provider credentials with verified provider-side spending controls, and the owner's chosen starting pool hours.
4. Owner recitation through the deployed path, including silence/resume, and an OBS browser-source check.
5. Stripe needs business activation and a separate test-mode flow. Quran Foundation permits app donations; resolve content retention/sync and source-specific rights before public hosting (see DEPLOY.md).

The pool is **not a hard financial ceiling**: Soniox invoices by tokens and hosting, relay bandwidth and JEV cost extra. The relay now closes real streams before refunding unused time. Provider-side spending limits remain necessary. No new live microphone-to-screen latency claim is made: the relay adds a network hop, and prior direct-stream timings do not certify it. See [Soniox pricing](https://soniox.com/pricing) and [deployment notes](DEPLOY.md).

Free signup does not imply suitable free production hosting: for example, [Render's free services](https://render.com/docs/free) sleep when idle and lack a persistent disk. Losing this app's state loses its pool ledger and visitor identity secret. Choose hosting before entering paid-service settings.
