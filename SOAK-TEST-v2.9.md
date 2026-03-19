# v2.9.0 Beta Soak-Test Plan

**Duration:** 30–60 minutes on a real deployment
**Image:** `ghcr.io/kha-kis/arr-dashboard:v2.9-beta`
**Immutable tag for debugging:** `ghcr.io/kha-kis/arr-dashboard:sha-<shortsha>` (first 7 chars of commit)

> The `v2.9-beta` tag is a **moving tag** updated on every push to `feat/v2.9`.
> Use `sha-<shortsha>` if you need to pin to a specific build for debugging.
> DockerHub mirrors (`khak1s/arr-dashboard:v2.9-beta`) are published when DockerHub secrets are configured.

---

## 0. Deploy

### Option A: SQLite (default)

```yaml
# docker-compose.yml
services:
  arr-dashboard:
    image: ghcr.io/kha-kis/arr-dashboard:v2.9-beta
    container_name: arr-soak
    ports:
      - "3000:3000"
    volumes:
      - ./config:/config
    environment:
      - PUID=1000
      - PGID=1000
```

```bash
docker compose up -d
# First run → visit http://localhost:3000/setup to create admin
```

### Option B: PostgreSQL

```yaml
# docker-compose.yml
services:
  postgres:
    image: postgres:16-alpine
    environment:
      POSTGRES_USER: arr
      POSTGRES_PASSWORD: arr_soak_pw
      POSTGRES_DB: arr_dashboard
    volumes:
      - pgdata:/var/lib/postgresql/data

  arr-dashboard:
    image: ghcr.io/kha-kis/arr-dashboard:v2.9-beta
    container_name: arr-soak
    ports:
      - "3000:3000"
    volumes:
      - ./config:/config
    environment:
      - PUID=1000
      - PGID=1000
      - DATABASE_URL=postgresql://arr:arr_soak_pw@postgres:5432/arr_dashboard
    depends_on:
      - postgres

volumes:
  pgdata:
```

### Endpoint Discovery Note

The API server listens on port 3001 inside the container but is proxied through the web server on port 3000.
Both `/health` endpoints return the same data:

- **Web proxy:** `http://localhost:3000/health` (recommended — this is what real users hit)
- **API direct:** `http://localhost:3001/health` (only accessible if port 3001 is exposed)

All `/api/*` paths below go through the port 3000 web proxy unless stated otherwise.

---

## 1. Health + Version Verification

**Time:** 2 min

| Step | Action | Expected |
|------|--------|----------|
| 1.1 | `curl -s http://localhost:3000/health \| jq .` | JSON with `status`, `version`, `commit` |
| 1.2 | Check `version` field | Starts with `2.9.0-beta` (e.g., `2.9.0-beta.42`) |
| 1.3 | Check `commit` field | 40-char hex SHA (NOT `unknown`, NOT empty, NOT `null`) |

**Example healthy response:**
```json
{
  "status": "ok",
  "version": "2.9.0-beta.42",
  "commit": "198c8cc1a2b3c4d5e6f7890abcdef1234567890a"
}
```

**If using PostgreSQL (optional degradation test):**

| Step | Action | Expected |
|------|--------|----------|
| 1.4 | `docker compose stop postgres` | — |
| 1.5 | `curl -s http://localhost:3000/health \| jq .` | HTTP 503: `{"status":"error","version":"...","reason":"Database unavailable"}` |
| 1.6 | `docker compose start postgres` | Health returns to `"ok"` within ~10s |

**Pass:** Version is `2.9.0-beta.*`, commit is a real SHA, degraded health returns 503.

---

## 2. PostgreSQL Secrets Migration (Option B only)

**Time:** 5 min — **Skip if SQLite-only**

Verifies that upgrading from v2.8.x (which stored secrets at `/app/api/data/secrets.json`) auto-migrates to the new path.

| Step | Action | Expected |
|------|--------|----------|
| 2.1 | `cat ./config/secrets.json` | File exists with `encryptionKey` + `sessionCookieSecret` |
| 2.2 | Copy it to legacy location: `docker compose exec arr-soak sh -c "mkdir -p /app/api/data && cp /config/secrets.json /app/api/data/secrets.json"` | — |
| 2.3 | Delete from new location: `docker compose exec arr-soak rm /config/secrets.json` | — |
| 2.4 | Restart: `docker compose restart arr-soak` | Container starts normally |
| 2.5 | `docker compose logs arr-soak \| grep "Migrating secrets"` | Line: `Migrating secrets from legacy path (v2.8.x upgrade)` |
| 2.6 | `cat ./config/secrets.json` | File restored with the same keys |
| 2.7 | Log in to the UI | Session works (encryption key preserved → existing data decryptable) |

**Pass:** Secrets auto-migrate; no data loss; login succeeds after restart.

---

## 3. Library Cleanup Safety Rails

**Time:** 10 min
**Prerequisite:** At least one Sonarr or Radarr instance connected with library data.

### 3a. Confirmation Dialog

| Step | Action | Expected |
|------|--------|----------|
| 3.1 | Navigate to **Settings → Library Cleanup** | Config page loads |
| 3.2 | Set **Dry Run Mode = ON**, click **Run Now** | Confirmation dialog: _"...flag matching items (dry run mode — nothing will be removed)."_ Button: **"Run Preview"** |
| 3.3 | Click **Cancel** | Nothing executes |
| 3.4 | Set **Dry Run Mode = OFF**, **Require Approval = ON**, click **Run Now** | Dialog: _"...queue matching items for approval."_ Button: **"Run & Queue"** |
| 3.5 | Set **Require Approval = OFF**, click **Run Now** | Dialog: _"...remove or unmonitor matching items. This action cannot be undone."_ Button: **"Run & Execute"** |
| 3.6 | Click **Cancel** | Nothing happens |

### 3b. Bulk Approval Batch Cap

The API enforces a maximum of **100 IDs** per bulk approval request.

**UI-first test:** If the approval queue has items, select all and approve — the UI should succeed (it batches correctly).

**Optional API/curl test:**

> **Getting your session cookie:** Open browser DevTools → Network tab → find any `/api/*` request → look in the `Cookie:` header for `arr_session=<value>`. Copy the full cookie value.

```bash
# Generate 101 fake IDs — should be rejected
IDS=$(python3 -c "import json; print(json.dumps([str(i) for i in range(101)]))")
curl -s -X POST http://localhost:3000/api/library-cleanup/approve \
  -H "Content-Type: application/json" \
  -H "Cookie: arr_session=YOUR_SESSION_COOKIE_HERE" \
  -d "{\"ids\": $IDS, \"action\": \"approve\"}" | jq .
```

**Expected:** HTTP 400 with Zod validation error about array max length (max: 100).

**Pass:** Dialog shows mode-appropriate text for all 3 modes; API rejects >100 IDs.

---

## 4. Cleanup "Why Flagged" Transparency

**Time:** 5 min
**Prerequisite:** Run a dry-run cleanup (step 3.2 above, confirm to execute) so the Logs tab has entries.

| Step | Action | Expected |
|------|--------|----------|
| 4.1 | Go to **Library Cleanup → Logs** tab | Table of log entries |
| 4.2 | Click any row | Row expands to show a detail panel |
| 4.3 | Inspect detail | Shows **Title** (media name), **Rule** (which rule matched), **Reason** (why it matched) |
| 4.4 | If present: **Action** and **Status** fields | Displayed as color-coded badges |
| 4.5 | Click the row again | Detail collapses |
| 4.6 | Click a different row | Previous collapses, new one expands |

**Pass:** Rows are clickable; detail panel shows rule/reason context.

---

## 5. Notifications: Test Send + Last Status + Truncation

**Time:** 10 min
**Prerequisite:** Create at least one notification channel (Discord webhook or Telegram bot recommended).

### 5a. Channel Test

| Step | Action | Expected |
|------|--------|----------|
| 5.1 | **Settings → Notifications → Add Channel** | Choose Discord or Telegram, fill in config |
| 5.2 | Save, then click **Test** | Success toast; test message arrives in Discord/Telegram |
| 5.3 | Refresh the channels list | `lastTestedAt` shows recent timestamp, `lastTestResult` = `"success"` |

### 5b. Delivery Tracking

| Step | Action | Expected |
|------|--------|----------|
| 5.4 | Subscribe channel to an event (e.g., `SYSTEM_STARTUP`) | — |
| 5.5 | Restart container: `docker compose restart arr-soak` | Notification delivered |
| 5.6 | Check channel list (UI or API) | `lastSentAt` is recent, `lastSendResult` = `"success"` |

**Optional API check:**
```bash
curl -s http://localhost:3000/api/notifications/channels \
  -H "Cookie: arr_session=YOUR_SESSION_COOKIE_HERE" | jq '.[0] | {lastSentAt, lastSendResult, lastTestedAt, lastTestResult}'
```

### 5c. Truncation (code-level)

These limits protect against oversized messages from large events:

| Sender | Limit | Behavior |
|--------|-------|----------|
| Discord | 25 fields per embed, 5500 chars total | Excess fields dropped |
| Telegram | 4000 chars | Message truncated with `(truncated)` suffix |

**Functional test:** Trigger a notification from a large event (e.g., a hunt finding many items). The notification should arrive complete or gracefully truncated — it must NOT fail with a 400 from Discord's API.

**Pass:** Test sends work; `lastSentAt`/`lastSendResult` populated; no silent delivery failures.

---

## 6. Plex/Tautulli: Cache Status + Manual Refresh + Eviction

**Time:** 10 min
**Prerequisite:** Plex or Tautulli instance connected.

### 6a. Cache Status

| Step | Action | Expected |
|------|--------|----------|
| 6.1 | Find instance ID: **Settings → Services** (or check the URL when editing) | UUID string |
| 6.2 | Check cache status: | JSON response |

```bash
curl -s http://localhost:3000/api/plex/cache/YOUR_INSTANCE_ID/status \
  -H "Cookie: arr_session=YOUR_SESSION_COOKIE_HERE" | jq .
```

**Expected:**
```json
{
  "instanceId": "...",
  "cachedItems": 1234,
  "hasCacheData": true
}
```

### 6b. Manual Refresh

| Step | Action | Expected |
|------|--------|----------|
| 6.3 | Trigger refresh: | `{"success":true,"upserted":<N>,"errors":<N>}` |

```bash
curl -s -X POST http://localhost:3000/api/plex/cache/YOUR_INSTANCE_ID/refresh \
  -H "Cookie: arr_session=YOUR_SESSION_COOKIE_HERE" | jq .
```

| Step | Action | Expected |
|------|--------|----------|
| 6.4 | Re-check status (step 6.2) | `cachedItems` matches or increases |
| 6.5 | Send the refresh POST **3 times rapidly** | 3rd request returns **HTTP 429 Too Many Requests** (rate limit: 2 per 5 minutes) |

### 6c. Cache Eviction

| Step | Action | Expected |
|------|--------|----------|
| 6.6 | Check logs: `docker compose logs arr-soak \| grep "evicted stale"` | If library changed since last sync: `"Plex cache: evicted stale rows"` with count |
| 6.7 | If no eviction logged | OK — means all cached items still exist in Plex. Eviction fires only when items are removed between syncs. |

### 6d. Tautulli (same pattern)

If Tautulli is configured, repeat 6.1–6.5 with:
- `GET /api/tautulli/cache/<instanceId>/status`
- `POST /api/tautulli/cache/<instanceId>/refresh`

**Pass:** Status returns cache count; refresh works; rate limit triggers on 3rd request; stale rows evicted.

---

## 7. Final Checks

**Time:** 5 min

| Step | Action | Expected |
|------|--------|----------|
| 7.1 | `docker compose logs arr-soak 2>&1 \| grep -ci "error"` | Note count — some are expected (e.g., "no channels subscribed") |
| 7.2 | `docker compose logs arr-soak 2>&1 \| grep -i "unhandled\|uncaught\|SIGTERM"` | **Empty** — no crash loops |
| 7.3 | `docker inspect arr-soak --format='{{.State.Status}}'` | `running` |
| 7.4 | `docker inspect arr-soak --format='{{.State.StartedAt}}'` | Single start time (no unexpected restarts) |
| 7.5 | Final health: `curl -s http://localhost:3000/health \| jq .status` | `"ok"` |

---

## Summary Checklist

| # | Area | Verified |
|---|------|----------|
| 1 | `/health` returns `2.9.0-beta.*` version + real commit SHA | ☐ |
| 2 | Health degrades to 503 when DB is down (PG only) | ☐ |
| 3 | Secrets auto-migrate from v2.8.x legacy path (PG only) | ☐ |
| 4 | Cleanup confirmation dialog shows context-aware text (3 modes) | ☐ |
| 5 | Bulk approval API rejects >100 IDs | ☐ |
| 6 | Cleanup log rows expand to show rule/reason detail | ☐ |
| 7 | Notification test send works, updates `lastTestedAt` | ☐ |
| 8 | Channel list shows `lastSentAt` / `lastSendResult` after delivery | ☐ |
| 9 | Plex/Tautulli cache status returns item count | ☐ |
| 10 | Manual cache refresh works, rate limits on 3rd call | ☐ |
| 11 | No crash loops or unhandled errors in container logs | ☐ |
| 12 | Container healthy after full soak | ☐ |

---

**All checks passing?** The beta is ready for final review and v2.9.0 tagging.
