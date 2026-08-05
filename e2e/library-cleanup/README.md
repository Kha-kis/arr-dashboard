# Disposable Library Cleanup live harness

This directory contains the isolated live test harness for Library Cleanup. It
creates project-scoped Radarr, Sonarr, Plex, qBittorrent, qUI, PostgreSQL, and
dashboard services; bootstraps deterministic hardlinked media; and runs
fail-closed policy and mutation scenarios for issues #616, #618, #619, #657,
#659, #660, and #667.

## Safety boundary

- Use a unique project name beginning with `lc-e2e-`, such as
  `lc-e2e-616-20260803-153000`. Live preflights reject empty, malformed,
  generic, production-like, and non-run-specific names.
- Every config, database, and media store is a Compose named volume. There are
  no host media/config/database bind mounts and no external volumes or networks.
- The base file publishes only one selected dashboard profile, on `127.0.0.1`.
  `compose.debug.yml` adds loopback-only setup entrypoints.
- qUI authentication is disabled only inside the isolated Compose subnet. Both
  upstream-required acknowledgements are set, and the allowlist must exactly
  equal that subnet. Never attach either qUI service to another network.
- Never point this harness at production service URLs or reuse production
  credentials. The Plex claim token, when used, should be short lived.

The validation script inspects the fully rendered model and refuses bind mounts,
external storage/networks, `container_name`, non-loopback published ports,
suspicious project names, qUI path/network/image/readiness drift, unsafe subnets,
invalid PostgreSQL passwords, unexpected services, and ARR/Plex volume drift.
It also statically verifies that the root `.dockerignore` excludes this entire
directory from the candidate image build context, including `.env*`, secrets,
logs, fixtures, and rendered artifacts.

## Exact shared-media topology

All rows below are different views of the same `shared-media` named volume:

| Service | Container-visible root | Intended fixture paths |
| --- | --- | --- |
| Radarr A | `/radarr-a/data` | `/radarr-a/data/library/radarr-a`, `/radarr-a/data/torrents/qbit-a` |
| Radarr B | `/radarr-b/data` | `/radarr-b/data/library/radarr-b`, `/radarr-b/data/torrents/qbit-b` |
| Sonarr A | `/sonarr-a/data` | `/sonarr-a/data/library/sonarr-a`, `/sonarr-a/data/torrents/qbit-a` |
| Sonarr B | `/sonarr-b/data` | `/sonarr-b/data/library/sonarr-b`, `/sonarr-b/data/torrents/qbit-b` |
| Plex | `/plex/data` | `/plex/data/library/radarr-a`, `/plex/data/library/radarr-b`, `/plex/data/library/sonarr-a`, `/plex/data/library/sonarr-b` |
| qBittorrent A + qUI A | `/data` in both containers | `/data/torrents/qbit-a` |
| qBittorrent B + qUI B | `/data` in both containers | `/data/torrents/qbit-b` |
| Dashboard candidate | `/data`, every `/*arr-*/data`, and `/plex/data` | Read-only evidence views of every path above |

The intentionally different ARR and Plex prefixes model path translation for
#616 while retaining one physical filesystem and inode space. qUI's local path
is different by design: official qUI behavior requires its path to match the
paired qBittorrent path **exactly**, so each pair mounts the same volume at
`/data`. Local Filesystem Access still has to be enabled when each qBittorrent
instance is added in qUI. The dashboard receives read-only views at both the
qBittorrent and service-specific prefixes so it can prove inode ownership but
cannot mutate fixture files directly. See qUI's official
[Docker filesystem guidance](https://getqui.com/docs/getting-started/docker/)
and [auth-disabled requirements](https://getqui.com/docs/configuration/environment/).

## Configure and validate

From this directory:

```sh
cp .env.example .env
mkdir -p secrets
openssl rand -hex 24 >secrets/postgres-password.txt
: >secrets/plex-claim.txt
# Edit .env and set a unique name, for example:
# COMPOSE_PROJECT_NAME=lc-e2e-616-20260803-153000
sh ./validate-compose.sh --live-project lc-e2e-616-20260803-153000
```

Put an optional Plex claim token in `secrets/plex-claim.txt`. It is supplied via
a Docker secret and is never interpolated into the rendered service environment.
Do not paste it into command-line arguments or logs.
The PostgreSQL password preflight reads the secret file without displaying its
value. It rejects empty values and anything outside URL-safe unreserved ASCII
characters (`A-Z`, `a-z`, `0-9`, `.`, `_`, `~`, and `-`).

The preflight only runs `docker compose config`; it does not build, pull, create,
or start containers. The baseline default is
`khak1s/arr-dashboard:2.23.0`, matching `docs/RELEASING.md`. Most images remain
configurable in the ignored `.env` for pinned compatibility runs. qUI is the
exception: both instances are allowlisted to the reviewed official
`ghcr.io/autobrr/qui:v1.16.1` image and use a Compose-defined probe against
`/healthz/readiness`. An arbitrary override such as `busybox` fails validation.

To update qUI, first verify that the proposed official image still contains
`wget` with the options used in `compose.yml` and serves the documented readiness
endpoint. Then update the Compose default, `.env.example`, and
`ALLOWED_QUI_IMAGES` together and rerun all positive and negative preflights.

## Profiles

Run exactly one dashboard profile at a time:

```sh
PROJECT_NAME=lc-e2e-616-20260803-153000

# Required immediately before a live command.
sh ./validate-compose.sh --live-project "$PROJECT_NAME"

# Candidate built from this checkout, SQLite
COMPOSE_PROJECT_NAME="$PROJECT_NAME" docker compose \
  --profile candidate-sqlite up --build --wait dashboard-sqlite

# Candidate built from this checkout, PostgreSQL
COMPOSE_PROJECT_NAME="$PROJECT_NAME" docker compose \
  --profile candidate-postgres up --build --wait dashboard-postgres

# Published 2.23.0 baseline reproduction
COMPOSE_PROJECT_NAME="$PROJECT_NAME" docker compose \
  --profile baseline up --wait dashboard-baseline
```

The Compose model has no project-name fallback. Do not use stale generic names
such as `lc-e2e-local`, and do not skip the live preflight.

Add `-f compose.yml -f compose.debug.yml` when loopback access to the service UIs
is intentionally needed for bootstrap. The base candidate entrypoints are:

- SQLite: `http://127.0.0.1:33030`
- PostgreSQL: `http://127.0.0.1:33031`
- v2.23.0 baseline: `http://127.0.0.1:33032`

Toxiproxy exposes its control API and reserved internal proxy ports only on the
Compose network. A later slice must create deterministic proxy routes and point
the dashboard's disposable service records at those routes before recovery tests
can be claimed.

## Bootstrap and live scenarios

After starting the candidate SQLite profile with the debug overlay, bootstrap
the integrations in this order:

```sh
sh ./bootstrap-arr.sh
sh ./bootstrap-torrents.sh
sh ./bootstrap-qui.sh
sh ./bootstrap-plex.sh
sh ./bootstrap-dashboard.sh
```

The unclaimed Plex fixture exposes real local library and episode metadata. Its
loopback-only bridge supplies one deterministic owner history row because an
unclaimed server does not publish owner history through the normal endpoint.
The application still performs its normal cache refresh, pagination, episode
metadata, shared-path, and mutation-boundary checks against Plex. The bridge has
no published port, storage, or connection to a non-harness network.

Run one scenario at a time. Restore all fixture layers after every destructive
scenario before testing the opposite direction:

```sh
sh ./run-live-scenario.sh policy-gate
sh ./run-live-scenario.sh policy-core
sh ./run-live-scenario.sh delete:radarr-uhd

sh ./bootstrap-arr.sh
sh ./bootstrap-plex.sh
sh ./bootstrap-torrents.sh
sh ./bootstrap-dashboard.sh

sh ./run-live-scenario.sh delete:radarr-hd
sh ./run-live-scenario.sh delete:sonarr-uhd
sh ./run-live-scenario.sh delete:sonarr-hd
sh ./run-live-scenario.sh episode:sonarr-uhd
```

`policy` runs the gate and core policy cases together when no fixture refresh
can occur between them. `policy-gate` is the deterministic qUI assertion: run
it only after the qUI torrent-state scheduler has published a complete fresh
generation. `policy-core` covers #618, #619, and #660 independently of that
scheduler timing.

The ARR bootstrap is idempotent for an already populated fixture. It skips an
unnecessary rescan when the exact expected file has one record and fails if an
ARR instance reports duplicate records for the same path, rather than letting
ambiguous ownership reach a cleanup scenario.

The Radarr and Sonarr series-deletion scenarios enable the #667 post-delete
media-server scan option and poll Plex directly without manually starting a
refresh. They therefore prove that the cleanup-triggered scan removes the
deleted variant while preserving the retained variant and shared Plex identity.

The runner refuses to proceed when a non-harness cleanup rule exists, an exact
service label or path is missing, preview selection is incomplete, or the peer
ARR item, shared Plex identity, or four qUI source torrents cannot be proven.

## Teardown

Use the guarded script and repeat the exact unique project name as confirmation:

```sh
sh ./teardown.sh \
  --project lc-e2e-616-20260803-153000 \
  --confirm lc-e2e-616-20260803-153000
```

The script accepts no caller-supplied Compose files or paths. It re-renders and
validates the exact base/debug harness model, confirms the rendered project name,
then runs `down --volumes --remove-orphans` for that project. It rejects defaults,
empty names, mismatched confirmation, and suspicious production-like names
before Docker can remove anything. Volume removal is irreversible; no production
data should ever be reachable from this harness.
