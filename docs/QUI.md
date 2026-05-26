# qui Integration

[autobrr/qui](https://github.com/autobrr/qui) is a federated, multi-instance qBittorrent UI. arr-dashboard talks to qui (not directly to qBittorrent) to surface torrent-layer signals — seed health, ratios, cross-seed siblings — alongside your *arr/library data.

This document covers what to expect after adding a qui instance, how the integration works, and known limitations.

## Adding a qui instance

1. **Settings → Services → Add Service → qui**
2. Enter the qui URL (default port `7476`) and an API key generated in qui's UI
3. Save. arr-dashboard will test the connection immediately

Once added, two background jobs activate:

- **`qui-torrent-state-sync`** runs every 10 minutes, snapshots torrent state from qui into arr-dashboard's library cache
- **`infohash-backfill`** drains your existing library on startup (~5 min for typical libraries), then runs every 6 hours to capture new items

You can monitor both jobs in **Settings → System → Background Jobs**.

## What you'll see

### Library page
- **Torrent state filter dropdown** with per-bucket counts: `Seeding (150) | Stalled download (3) | Not correlated with qui (1962) …`
- **Per-card badge** showing `Seeding · 1.24×` (or current state + ratio) on every item correlated with a qui torrent
- **Sort by torrent ratio** in the sort dropdown

### Library item detail modal
- **Torrent Health panel** with full state, ratio, seed time, peers, cross-seed siblings, and tracker health
- **Torrent action bar** (Phase 4.1) — Pause / Resume / Recheck / Reannounce / Set Tags. Each click writes an audit row before the qui call fires; see **My Actions** below.

### Cross-Seed Discovery page (Phase 3.1 / 4.2)
- Bulk selection toolbar — pick multiple cross-seed candidates and pause/resume/recheck/reannounce in one click. Selected hashes are grouped by qBit instance and dispatched in parallel; partial failures show in the result toast.
- Per-batch "Unreachable" counter when qui errored on some items' sibling lookups — distinguishes "scan found nothing" from "scan was incomplete".

### qui Activity page — three logs in one surface
**Activity feed** — observed events emitted by arr-dashboard's own schedulers (sync ticks, gate firings, webhook drops). One row per scheduler tick.
**My Actions** — tamper-evident audit log of mutations YOU initiated through arr-dashboard. One row per (action, info-hash) pair, including `failed` rows with qui's error message.
**My Events** — inbound webhook events qui POSTed to arr-dashboard. Empty until you configure the Webhook tab.
**Webhook** — rotate the secret + auto-register arr-dashboard as a NotificationTarget inside qui (Phase 5.1). When configured, qui pushes state changes to the dashboard within seconds instead of the 10-minute polled sync.

### Pulse (dashboard footer)
- **Seeding Health domain badge** showing the rollup health of all your qui instances
- Per-instance attention rows when a qBittorrent instance behind qui is disconnected
- **Webhook drop counter** — when qui POSTs a webhook but arr-dashboard can't persist the row (rare DB issue), the receiver acknowledges qui anyway (to stop retry storms) and records the gap on Pulse so you see it on the health dashboard, not just in logs.

## How correlation works

To link an *arr library item to a qui torrent, arr-dashboard needs the torrent's **infoHash**. There are two paths:

1. **From *arr's grab history** — when you originally grabbed the item, *arr recorded a `downloadId` which IS the qBittorrent infoHash. The backfill scheduler walks every cached library item and queries the relevant *arr's `/api/v3/history/movie` (Radarr) or `/api/v3/history/series` (Sonarr) endpoint to populate the hash.
2. **On-demand** when you open an item modal — same lookup, just runs immediately for that one item.

Once an item has an infoHash, the qui sync correlates it against qui's known torrents and persists the state.

## The "Not correlated with qui" bucket

This bucket includes items where *either*:
- qui has no torrent matching our infoHash (you removed it from qBit), OR
- The infoHash backfill couldn't find a `downloadId` in *arr's history for that item

**The most common cause is *arr history pruning.** Sonarr and Radarr default to keeping a finite number of history records. Items grabbed long ago — or before a database rebuild — have no audit trail back to a torrent. arr-dashboard cannot recover those without help from qui.

To grow coverage:
- **Increase Settings → General → History Retention** in your *arr instances (default is usually too short)
- **Re-grab old items** if you want them correlated (the new grab record will populate the infoHash)

A status hint surfaces next to the filter dropdown when this bucket dominates (>30% of your library) so you know it's a *arr-side concern, not an integration bug.

## Known limitations

### Cross-host filesystem hardlink validation

If your qui instance and your *arr instances run on the same filesystem (typical), file hardlink relationships exist on disk and qui's internal `HardlinkIndex` can verify them. **However, qui doesn't currently expose a public API to query torrents by file path** — every torrent-lookup endpoint takes a torrent hash as input. arr-dashboard relies on the *arr-history `downloadId` correlation path described above.

An upstream feature request (`POST /api/torrents/find-by-content-signature`) would close this gap by letting arr-dashboard ask qui "do you have a torrent that matches this file signature?" without needing to round-trip through *arr's history. Status tracked separately.

### Music and books

qui doesn't currently track Lidarr/Readarr items. The integration excludes artist/author rows from sync entirely — they'll never appear in the Torrent state filter and never have a badge.

### Mutations are audited, not unbounded

Starting in v2.20, arr-dashboard can pause/resume/recheck/reannounce torrents and set tags (Phase 4). Every operator-initiated mutation creates a row in `QuiActionLog` BEFORE the qui call fires (intent recording), then transitions to `success` or `failed`. See **My Actions** below.

Destructive operations qui exposes — `delete`, `delete-with-files`, category changes — are deliberately NOT wired. The action vocabulary surfaced through arr-dashboard is "things you can undo by clicking the inverse action": pause/resume mirror each other; recheck/reannounce are idempotent; setTags overwrites only the tag list. If you need a destructive operation, do it in qui directly.

## Webhook setup (push freshness — Phase 5.1)

By default, arr-dashboard polls qui every 10 minutes for torrent state. If you want changes to surface in seconds instead, register arr-dashboard as a qui NotificationTarget:

1. **qui Activity → Webhook tab → "Rotate secret"**. The plaintext secret is shown EXACTLY ONCE — copy it or proceed directly to step 2.
2. Either:
   - **Auto-register** (single click): pick the qui instance from the list, click "Register selected instance." arr-dashboard POSTs to qui's `/api/notifications/targets` with the full URL + secret.
   - **Manual**: copy the full URL (with `?secret=...`) into qui's Settings → Notifications → Targets → URL field. Method `POST`.
3. Trigger an event in qui (pause/resume a torrent) to verify the wire works. The **Recent events** strip on the Webhook tab will show the event within a second, and the qui-activity tabs become push-driven instead of polled.

**Secret hygiene notes:**
- The plaintext secret is never persisted — only its SHA-256 hash is stored. Rotating generates a new secret and invalidates the old; you'll need to re-register or update qui's NotificationTarget URL.
- Query-string secrets land in nginx/Caddy/Cloudflare access logs by default. arr-dashboard's own pino logger redacts `?secret=` from request URLs, but **you should redact the same in your reverse-proxy access logs** if you're worried about log-aggregator access. qui's openapi only supports `ApiKeyQuery` so a header-based scheme isn't available upstream.
- The hash includes a domain prefix (`qui-webhook-v1:`) so a leak of this secret can't be replayed against the auto-tag webhook (which uses a separate hash domain).

## Privacy mode (incognito)

When incognito mode is enabled, the per-card badge stays visible (state + ratio aren't identifying) but the modal anonymizes:
- Torrent names → Linux ISO-style placeholders
- qBit instance names → "qbit"
- Tracker hostnames → "tracker"

Pulse rows that combine the qui label and qBit instance name (`"Home Qbit: qbit-main is disconnected"`) anonymize BOTH names — no leakage of either.

## Troubleshooting

| Symptom | Cause | Fix |
|---|---|---|
| Torrent state dropdown shows "correlating…" | Backfill catch-up is running but no items have been correlated yet | Wait 5-10 min for the first batch to complete |
| All items in "Not correlated with qui" bucket | qui sync hasn't run since adding the instance | Check Settings → System → Background Jobs for `qui-torrent-state-sync` last-run status |
| Most items show as "Not correlated" forever | *arr history retention is too short | Increase Settings → General → History Retention in your *arr instances |
| Badge shows "Unknown · X×" | qui returned a state arr-dashboard's vocabulary doesn't map | File an issue with the state name; the bilingual `describeQuiState` util needs the new entry |
| Pulse rows linking to wrong settings tab | Pulse caches per-user response for 60s | Wait 60s for the cache to refresh |
| "Live channel offline" pill stuck on qui Activity | Session expired, API restart, or SSE route returning 401 | The EventSource will auto-retry; if it stays offline, refresh the page so it picks up a fresh session cookie |
| qui Activity shows `qui_webhook_dropped` rows | Inbound webhook arrived but the QuiEventLog insert failed (disk full / schema drift) | Check arr-dashboard logs for the underlying DB error; this is the same signal Pulse surfaces |
| "My Actions" row stuck in `pending` | qui call succeeded but our success-update DB write failed | Audit-log self-heals on the next action you trigger; the qui mutation DID succeed (we record outcome on the qui side too) |
| `setTags` action 400s with "requires a non-empty tags field" | Body validation — `setTags` is the only action that needs a body | Provide the tag list as a comma-joined string |
