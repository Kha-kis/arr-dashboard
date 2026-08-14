# Media analytics integration harness

This harness runs arr-dashboard with real Plex, Tautulli, and Tracearr services
inside the dedicated Docker Compose project
`arr-dashboard-media-analytics-e2e`. It is a disposable local test environment,
not a production-service test tool.

## Prerequisites

- Docker with Compose v2
- Node.js and the repository's pnpm dependencies
- `bash`, `curl`, `jq`, and `openssl`
- A Plex account for the current pinned provider baseline

The stack publishes only loopback ports. It starts six long-running containers
and builds the local arr-dashboard image, so allow several gigabytes of image
and volume storage. The one-shot FFmpeg container runs only when synthetic media
must be generated.

Host ports default to the values in `.env.example`. To change them, copy that
file to `.env` and edit only the port or timezone values. Shell overrides take
precedence. Never put a Plex claim or another credential in `.env`; all shell
and Playwright clients resolve the same validated port set.

## First run

Generate a short-lived claim at <https://plex.tv/claim>, then run it only on the
command invocation:

```bash
PLEX_CLAIM=claim-... pnpm e2e:media-analytics:reset
pnpm e2e:media-analytics
```

The claim expires quickly. It is passed only to Plex's first container start,
then the Plex container is recreated with an empty claim value. The harness
reads the server-issued token from Plex's owner-only container configuration for
downstream setup; it does not print it or copy it into `runtime.env` or
`bootstrap.json`. The disposable providers retain credentials in their normal
private configuration stores. Supplying `PLEX_TOKEN` is rejected.

The current pinned Tautulli and Tracearr flows require a claimed Plex server for
the complete smoke. Unclaimed local mode fails with a claimed-mode instruction
instead of reporting a partial success.

## Reuse and tests

After the first successful claim, the retained Plex volume stays claimed:

```bash
pnpm e2e:media-analytics:up
pnpm e2e:media-analytics
```

`up` is idempotent. It signs in to existing fixture accounts, reuses only exact
service identities, refreshes disposable provider credentials, and reruns all
three arr-dashboard connection tests. A label or endpoint collision fails
closed instead of creating another instance. An owner-only host runtime lock,
keyed by the fixed Compose project, rejects concurrent bootstrap runs from any
worktree before provider enrollment.

External service images and both Node base stages use reviewed tag-and-digest
pairs. Updating an upstream version requires updating its expected digest in the
Compose behavior test.

The browser smoke stores its disposable session and failure artifacts beneath
gitignored, owner-only `e2e/media-analytics/.state/`. It verifies:

- Plex, Tautulli, and Tracearr are rendered in Settings;
- each card's real connection-test action succeeds; and
- setup describes Tracearr as recommended and Tautulli as the supported
  alternative, with one historical provider selected at a time.

Focused harness tests can be run without changing the live stack:

```bash
node --test e2e/media-analytics/tests/lifecycle.test.mjs
node --test e2e/media-analytics/tests/compose.test.mjs
node --test e2e/media-analytics/tests/bootstrap.test.mjs
```

## Stop, reset, and purge

```bash
pnpm e2e:media-analytics:down   # stop containers; retain volumes
pnpm e2e:media-analytics:up     # resume retained state
pnpm e2e:media-analytics:reset  # verify ownership, purge volumes, start fresh
pnpm e2e:media-analytics:purge  # verify ownership, remove stack and volumes
```

`reset` and `purge` re-resolve and verify the Compose project label immediately
before deletion. A reset removes the claimed Plex volume, so its first fresh run
needs a new invocation-only claim.

## Diagnostics

Bootstrap names the service that failed and leaves the stack running. Inspect
only this owned project with:

```bash
docker compose --project-name arr-dashboard-media-analytics-e2e \
  --file e2e/media-analytics/docker-compose.yml ps
docker compose --project-name arr-dashboard-media-analytics-e2e \
  --file e2e/media-analytics/docker-compose.yml logs --tail=200 SERVICE
```

Do not publish `.state` content or logs containing provider credentials.

## Follow-up boundary

This foundation proves real provider enrollment, rendered setup guidance, and
connection health. Provider selection, cross-provider data isolation, outage,
recovery, incognito, and deterministic playback-history assertions belong to
the focused provider-selection follow-up; they are not claimed by this smoke.
