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

### Pulse (dashboard footer)
- **Seeding Health domain badge** showing the rollup health of all your qui instances
- Per-instance attention rows when a qBittorrent instance behind qui is disconnected

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

### Read-only by design

Through the current release, the integration is purely read-only. Bulk torrent actions (delete, force-recheck, change category) are deferred to a future release with a proper audit log.

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
