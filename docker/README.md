# Docker Deployment

This directory contains files for building and deploying Arr Dashboard as a single container.

## Container Architecture

API and Web run together in one container for simple deployment:
- **Simpler deployment** — One container to manage
- **Easier networking** — No container linking needed
- **Lower overhead** — Shared resources and dependencies

### Supported topology

Stable 2.x supports exactly one arr-dashboard API/container per database. Do not run multiple replicas or containers against the same SQLite or PostgreSQL database. Caches, scheduler timers, event fan-out, and most runtime coordination are process-local and are not coordinated across API processes. A few library-cleanup workflows use database-backed leases, but those leases do not establish general API ownership or make a multi-API topology supported.

Native startup and runtime ownership guards reject competing cooperating actors.
They do not make multiple API replicas, external database writers, or older images
that lack these guards a supported topology. Stop and wait for every known older
API/container before the first guarded startup; a free coordination lock does not
prove that an older process has stopped.

## Files

| File | Purpose |
|------|---------|
| `start-combined.sh` | Container entrypoint — PUID/PGID setup, provider client preparation, native schema/settings actor, service startup |
| `validate-runtime.sh` | CI validation script — checks all required files exist in the built image |
| API `dist/schema-startup.js` | Native actor — validates and applies fixed reviewed schema atoms, commits its destination-local receipt, reads settings, and proves closure before returning JSON |

## Running the Container

### Docker Run

```bash
docker run -d \
  --name arr-dashboard \
  --stop-timeout 120 \
  -p 3000:3000 \
  -v /path/to/config:/config \
  -e PUID=1000 \
  -e PGID=1000 \
  --restart unless-stopped \
  khak1s/arr-dashboard:latest
```

### Docker Compose

```bash
docker-compose up -d
```

## Database Configuration

### SQLite (Default)

No configuration needed. Database stored at `/config/prod.db`:

```bash
docker run -d \
  --name arr-dashboard \
  --stop-timeout 120 \
  -p 3000:3000 \
  -v /path/to/config:/config \
  khak1s/arr-dashboard:latest
```

### PostgreSQL

Set `DATABASE_URL` to a PostgreSQL connection string. The container automatically detects the provider and selects its prebuilt Prisma/API package:

```bash
docker run -d \
  --name arr-dashboard \
  --stop-timeout 120 \
  -p 3000:3000 \
  -v /path/to/config:/config \
  -e DATABASE_URL=postgresql://user:password@db-host:5432/arr_dashboard \
  khak1s/arr-dashboard:latest
```

Both `postgresql://` and `postgres://` URL schemes are supported.

At startup, the container runs a native actor as the effective runtime user before
starting the API or Web server. The actor preflights the complete native catalog
against packaged, hash-bound SQL and metadata. It applies only registered compatible
changes while retaining provider ownership and exclusion, then commits the schema,
startup journal and positive migration receipt together. It does not run a
destination Prisma schema engine, accept arbitrary SQL, or offer reset/data-loss
override flags. SQLite and PostgreSQL client generation and compilation occur
only during image build. Startup validates the selected package's file manifest,
schema, compiled provider and pinned client version without rewriting application
code. The native actor and API launcher use that same package. Image-owned API
files remain root-owned and read-only to the runtime user, including arbitrary
rootless users; only the mounted configuration/data and the documented Web image
cache require runtime write access. Provider selection is not a data conversion:
changing the connection URL selects a different database, not a migration of its
contents.

A successfully read missing settings row may fall back to environment/default
ports. A failed or malformed settings read stops startup instead. In the combined
container, configured database ports and listen address take precedence over
environment values, which take precedence over defaults. The standalone API's
separate environment-first precedence is unchanged.

Unknown constraints, incompatible historical shapes, missing ownership evidence,
or interrupted unanchored coordination refuse startup without reset or automatic
repair. Compatible custom columns, indexes, views and triggers are preserved.
SQLite retains its DELETE or WAL journal mode and original physical storage
binding. If an upgrade requires an explicit migration, preserve the stopped
database and follow the release's validated backup/migration procedure.

### Upgrade and rollback safety

Before an upgrade, quiesce the target and create a recoverable, owner-only
snapshot using the database provider's supported backup mechanism. Verify the
snapshot exists and prove recovery in an isolated disposable target before
allowing schema synchronization: run the provider's integrity checks against a
copied SQLite snapshot, or restore a PostgreSQL dump into a separate temporary
database and verify bounded pre-upgrade invariants without exposing row values.

The native actor never treats loss of COMMIT acknowledgement as proof of rollback.
A later guarded startup validates the destination catalog and original protocol
evidence; it does not blindly replay an uncertain transaction. An orphaned or
mismatched SQLite coordination namespace requires a validated operator recovery
procedure, not deletion of sidecars or copying another installation's binding.
Keep the database and coordination evidence together. No automatic orphan repair
is provided.

An old image is not a database downgrade tool. If rollback is required after a
successful schema transaction, stop and wait for the new image, use the rehearsed
provider recovery procedure for the pre-upgrade snapshot and its corresponding
storage/coordination state, then start the prior image. Do not run old and new
images together or reuse an inode-bound anchor after a database file replacement.

## Environment Variables

### Core

| Variable | Default | Description |
|----------|---------|-------------|
| `PUID` | `911` | User ID for file permissions |
| `PGID` | `911` | Group ID for file permissions |
| `DATABASE_URL` | `file:/config/prod.db` | Database connection (SQLite path or PostgreSQL URL) |
| `PORT` | `3000` | Web server port |
| `API_PORT` | `3001` | API server port (internal) |
| `HOST` | `0.0.0.0` | Listen address |

### Session & Security

| Variable | Default | Description |
|----------|---------|-------------|
| `SESSION_TTL_HOURS` | `24` | Session expiration (1-720 hours) |
| `SESSION_COOKIE_NAME` | `arr_session` | Session cookie name |
| `SESSION_COOKIE_SECRET` | Auto-generated | Cookie signing secret (saved to `/config/secrets.json`) |
| `ENCRYPTION_KEY` | Auto-generated | AES-256-GCM key for API key encryption (saved to `/config/secrets.json`) |
| `TRUST_PROXY` | `false` | Set `true` when behind a reverse proxy (enables X-Forwarded-* headers) |
| `COOKIE_SECURE` | Auto-detected | Force secure cookies (`true`/`false`/`auto`). Auto detects HTTPS |

### Rate Limiting

| Variable | Default | Description |
|----------|---------|-------------|
| `API_RATE_LIMIT_MAX` | `200` | Max requests per minute |

### WebAuthn / Passkeys

| Variable | Default | Description |
|----------|---------|-------------|
| `WEBAUTHN_RP_NAME` | `Arr Dashboard` | Display name shown during passkey registration |
| `WEBAUTHN_RP_ID` | `localhost` | Your domain (no protocol, e.g., `dashboard.example.com`) |
| `WEBAUTHN_ORIGIN` | `http://localhost:3000` | Public browser origin; also an OIDC callback fallback when `APP_URL` is local |

### Logging

| Variable | Default | Description |
|----------|---------|-------------|
| `LOG_LEVEL` | `info` | Log level: `debug`, `info`, `warn`, `error` |
| `LOG_DIR` | `/config/logs` | Log file directory |
| `LOG_MAX_SIZE` | `10m` | Max log file size before rotation |
| `LOG_MAX_FILES` | `5` | Number of rotated log files to keep |

### Optional

| Variable | Default | Description |
|----------|---------|-------------|
| `GITHUB_TOKEN` | — | GitHub token for TRaSH Guides (higher rate limits) |
| `APP_URL` | `http://localhost:3000` | Preferred public URL for OIDC callbacks (e.g., `https://dashboard.example.com`) |
| `SHUTDOWN_GRACE` | `90` | Shared API/web shutdown window in seconds. The API child gets one second less for its final join. Configure the outer engine timeout to at least 120s for this default (`docker run --stop-timeout 120`, Compose `stop_grace_period: 120s`, or equivalent). Explicitly shorter values may force an otherwise valid cache transaction to stop; forced termination remains a failed stop. |

Shutdown closes admission and joins already-entered work. A cache publication
transaction may legitimately need up to 60 seconds; interrupting it after the
former six-second API window was not a reliable upgrade path. Services that
finish sooner exit immediately: 90 seconds is a deadline, not a fixed wait.
Genuinely hung services are still terminated and reported as failed.

The image cannot change Docker's default 10-second outer timeout. The supplied
Compose file and commands above explicitly allow 120 seconds. Existing containers
retain their creation-time timeout until updated with that configuration. For a
one-off stop/restart, use `docker stop --time 120` or `docker restart --time 120`.
If you increase `SHUTDOWN_GRACE` beyond 90, also leave sufficient outer cleanup
margin; the supervisor may need child reaping and failure handling after the
shared window expires. An old image still has its old internal deadline even
when its external timeout is increased.

## Ports

- **3000** — Web UI (required)
- **3001** — API (internal, only expose for direct API access)

## Volumes

- `/config` — Database, secrets, logs, and backups

## Health Check

The probes are unauthenticated and have different purposes:

- **Docker HEALTHCHECK**: `http://localhost:3000/live` (runs every 30s). This
	checks that the web process and the API liveness endpoint respond, without
	waiting on the database. The combined-container supervisor exits if either
	process dies. Long cache transactions must not trigger a process restart.
- **Database readiness and external monitoring**: `http://<host>:3000/health`.
  Monitor this separately when deciding whether data-backed requests are usable.

`/live` returns a generic `{ "status": "ok" }`; `/health` returns version and
commit with `status: "ok"` only when the API database probe succeeds. A Docker
`healthy` status alone is not a full application-readiness result.

The image allows a **10-minute startup grace** because populated databases can
require several minutes of native validation before the web/API start. Failed
probes during this grace leave the container `starting`, not `healthy`. A real
successful probe marks it healthy immediately and ends the grace; subsequent
failures use the normal 30-second interval, 10-second timeout and three retries.
A genuinely hung initial startup can remain `starting` for up to 10 minutes
before failed probes begin counting toward `unhealthy`.

Compose and other orchestrators can override the image's health policy. If you
provide a Compose `healthcheck`, retain `start_period: 10m` (and the liveness
probe) rather than restoring a short initialization budget. Do not skip native
validation, treat `starting` as ready, or disable recovery to accommodate it.

To check the packaged health policy with a disposable delayed-start fixture:

```bash
node --test docker/test-startup-health.test.cjs
node docker/test-startup-health.cjs arr-dashboard:latest
```

This test requires Docker Engine 25 or newer for the accelerated probe interval.
It uses the image's actual health command and startup grace, an isolated network,
and temporary memory-backed metadata. It does not open a database or contact
providers. It verifies delayed startup, early healthy status, and a later real
liveness failure, then removes only its own container.

If Docker does not acknowledge fixture creation or cleanup, the command fails
and reports closure as unconfirmed, with the unique fixture name, owner label
and image ID for targeted reconciliation. It never assumes an unsuccessful CLI
reply means no container was created or broadens cleanup to other containers.

## Building

From the repository root:

```bash
docker build -t arr-dashboard:latest .
```

### Multi-Platform

```bash
docker buildx build \
  --platform linux/amd64,linux/arm64 \
  -t khak1s/arr-dashboard:latest \
  --push \
  .
```

## Troubleshooting

```bash
# View logs
docker logs arr-dashboard

# Access shell
docker exec -it arr-dashboard sh

# Check health
curl http://localhost:3000/health
```
