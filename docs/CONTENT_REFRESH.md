# Production Quran content

The public reader uses Quran Foundation's authenticated production Content API.
Keep `QF_CLIENT_ID` and `QF_CLIENT_SECRET` only in the ignored, private
`deploy/production.env`. Prelive credentials do not provide the full Quran.

Build the `live` target, then refresh before starting the reader:

```sh
docker build --target live -t quran-reader:live .
docker run --rm --env-file deploy/production.env -v quran-reader-content:/app/data/live quran-reader:live npx tsx scripts/sync-content.ts
```

Mount the same `quran-reader-content` volume at `/app/data/live` in the reader.
Keep financial state on its separate existing `/app/data/state` volume. The live
image requires a validated content checkpoint; it contains no bundled verse or
translation cache. The default `bundled` target is for local use and CI.

Install `deploy/quran-content-refresh.service` and `.timer` in
`/etc/systemd/system`, then run `systemctl daemon-reload` and
`systemctl enable --now quran-content-refresh.timer`. These units assume the
checkout is `/opt/quran-reader` and the image is tagged `quran-reader:live`.
Check `systemctl status quran-content-refresh.service` and
`journalctl -u quran-content-refresh.service` after a manual first run. A failed
job retains the last validated generation; investigate failures before six days
elapse. The reader refuses stale content after six days and needs a successful
refresh to resume. Docker must use `--restart unless-stopped`.

Each refresh fetches complete snapshots of Quran core 1, Mushaf 1, translation 20,
English word meanings 59, transliteration 60, and fresh Imlaei search text. The
checkpoint changes only after all 6,236 ayahs, chapter structure, word mappings
and font coverage validate. No missing scripture is generated. Four current
compound-word segmentation differences omit word glosses rather than attach a
meaning to the wrong Arabic word; full-ayah translations remain available.

Changed content causes a graceful reader restart within a minute, which can
interrupt a listening session. Unchanged refreshes only renew the checkpoint.
Old generations are removed after a one-day handover window on a subsequent
successful refresh. Checkpoints contain a provider sync token and must remain
private. Do not publish the content volume or raw datasets.

This refresh arrangement supports the current
[Quran Foundation Developer Terms](https://api-docs.quran.com/legal/developer-terms/).
Maintain the active developer account, source attribution and resource-specific
permissions; this document is not a grant to redistribute source datasets.
