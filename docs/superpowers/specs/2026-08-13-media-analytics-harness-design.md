# Reusable Media Analytics Integration Harness

**Status:** Proposed
**Date:** 2026-08-13
**Target:** `next` / arr-dashboard 3.0
**Related:** ADR-0009 and the Tracearr/Tautulli provider-choice work

## Decision

Add a dedicated, reusable Docker Compose and Playwright harness under
`e2e/media-analytics/`. It will run arr-dashboard with real Plex, Tautulli, and
Tracearr services while keeping every container, network, volume, credential,
and generated fixture isolated under the explicit Compose project
`arr-dashboard-media-analytics-e2e`.

The harness is separate from `e2e/integration/`. The existing suite covers the
broad service matrix, while this suite owns the deeper Plex analytics-provider
contract and its slower supporting services.

Tracearr and Tautulli are not treated as simultaneous data sources. Tests may
configure both, but each assertion selects one provider family and verifies that
arr-dashboard neither combines the families nor silently fails over.

## Goals

1. Make Plex, Tautulli, and Tracearr verification repeatable without pointing
   tests at an operator's production services.
2. Exercise real service APIs and browser flows instead of provider mocks.
3. Verify the connection, setup, provider-selection, degradation, and isolation
   behavior promised by ADR-0009.
4. Make repeated local runs fast by retaining explicitly owned image layers and,
   when requested, reusable service volumes.
5. Make startup, reset, and teardown fail closed so an ambiguous Compose project
   or external service can never be mutated.

## Non-goals

- The first implementation does not run in pull-request CI. It becomes eligible
  for manual CI only after local bootstrap is non-interactive and timing is
  stable on both amd64 and arm64.
- The harness does not seed or edit Plex, Tautulli, Tracearr, or arr-dashboard
  private databases.
- It does not use production URLs, credentials, media, or history.
- It does not validate cleanup deletion. Cleanup requires its own enrolled
  identity and mutation-focused fixtures; analytics data from this harness must
  not authorize a destructive action.
- It does not prove every upstream version. One pinned known-good version per
  service is the deterministic baseline; compatibility matrices remain separate
  work.

## Repository surface

The implementation adds:

```text
e2e/media-analytics/
  README.md
  docker-compose.yml
  .env.example
  scripts/
    common.sh
    preflight.sh
    generate-secrets.sh
    bootstrap.sh
    wait-for-services.sh
    reset.sh
    teardown.sh
  fixtures/
    generate-media.sh
  playwright.config.ts
  global-setup.ts
  media-analytics.spec.ts
```

Root scripts provide one stable interface:

```text
pnpm e2e:media-analytics:up
pnpm e2e:media-analytics
pnpm e2e:media-analytics:reset
pnpm e2e:media-analytics:down
```

`up` creates or resumes the owned stack and bootstraps it idempotently. `reset`
removes only verified harness resources and creates a clean stack. `down` stops
the stack while retaining its volumes by default. An explicit, separately named
purge command may remove verified harness volumes.

## Compose architecture

The stack contains:

- arr-dashboard frontend, backend, database, and Redis;
- the official Plex Media Server container;
- the official Tautulli container;
- Tracearr with its documented TimescaleDB and Redis dependencies; and
- a pinned media-generation container used as a one-shot job.

Images use immutable version tags or digests recorded in `.env.example`; no
service uses `latest`. Renovation is an intentional dependency change with a
focused harness run. Host ports are loopback-bound and overridable. Containers
communicate through Compose service names on a private network, and the Compose
file does not set fixed `container_name` values.

The scripts always pass
`--project-name arr-dashboard-media-analytics-e2e`. Before any reset, volume
removal, or teardown, `preflight.sh` obtains the candidate resources from Docker
and verifies their Compose project labels. A missing label, unexpected project,
unresolved path, non-loopback dashboard URL, or non-private provider endpoint
stops the operation before mutation.

Named volumes contain only disposable harness state. Source bind mounts are
read-only except for the application development mount required by the existing
arr-dashboard container pattern. Generated state lives in a gitignored run
directory beneath `e2e/media-analytics/`, has owner-only permissions, and is
removed by the verified purge path.

## Credentials and Plex modes

Every arr-dashboard, database, Tautulli, and Tracearr secret is generated for the
run. Values are written only to the gitignored owner-readable run-state file and
are never printed by normal scripts.

Plex supports two explicit modes:

### Local mode

Local mode is the default. Plex remains unclaimed and permits unauthenticated
access only from the dedicated Compose subnet. Bootstrap supplies a non-secret
test token where a client schema requires a non-empty value. This mode is valid
only when the real Plex API confirms that the application and both providers can
complete their supported connection flows. If an upstream release rejects that
flow, bootstrap reports local mode as unsupported instead of weakening network
scope or fabricating success.

### Claimed mode

Claimed mode is opt-in for history-generation behavior that requires a Plex
account. The operator provides `PLEX_CLAIM` at invocation time. The short-lived
claim value is passed to the first container start, is never copied into the
run-state file, and is unset from subsequent Compose invocations. Any durable
Plex token needed by the clients must be supplied through an owner-only local
environment file or obtained through a supported Plex flow; the harness does
not scrape or edit Plex's private database.

Startup rejects claimed mode when the required value is absent and rejects any
pre-existing Plex configuration that does not carry the expected Compose project
ownership. Documentation states that claimed mode contacts Plex's external
service and is therefore not an offline test.

## Bootstrap sequence

Bootstrap is idempotent and records a schema version in run state:

1. Run preflight checks for Docker, Compose, ports, ownership, environment, and
   loopback/private network boundaries.
2. Generate run secrets and a tiny synthetic, freely generated media file. Mount
   the resulting media read-only into Plex.
3. Start Plex and wait for its documented health endpoint.
4. Configure a deterministic test library through supported Plex HTTP APIs or
   browser setup. Do not write Plex storage directly.
5. Start and configure Tautulli through its supported first-run browser/API flow,
   then verify its Plex association and Tautulli API response.
6. Start Tracearr, TimescaleDB, and Redis; complete Tracearr's supported setup
   flow; connect it to the same Plex server; and verify its health and API
   response.
7. Start arr-dashboard, create the disposable local administrator, and add Plex,
   Tautulli, and Tracearr through arr-dashboard's public setup/API surfaces.
8. Run each arr-dashboard connection test and persist only the generated
   non-production identifiers needed by Playwright.
9. Mark bootstrap complete only after all real service checks pass.

A failed step leaves bootstrap incomplete and prints the failing service and
bounded diagnostic command. A later `up` retries safely. No script reports a
healthy stack based only on container-running state.

## Test contract

The first delivery milestone must pass these tests against real containers:

1. The lifecycle scripts reject resources not owned by the expected Compose
   project.
2. Plex, Tautulli, and Tracearr each pass arr-dashboard's real connection test.
3. Setup presents Tracearr as recommended and Tautulli as a supported
   alternative, without suggesting both are simultaneously selected.
4. With both configured and Tracearr selected, Tautulli history cannot enter the
   selected-provider result.
5. With Tautulli selected, Tracearr history cannot enter the selected-provider
   result.
6. Stopping the selected provider produces an explicit degraded state and does
   not silently use the other provider.
7. Restarting the selected provider restores its own data path without changing
   the stored provider choice.
8. Incognito mode masks provider and media identifiers on the exercised pages.

The second milestone adds deterministic historical playback assertions. It may
begin only after a playback event can be created through a supported Plex client
or API and observed independently by both providers. The same event is used to
assert normalized Tautulli and Tracearr behavior in separate provider selections.
If Plex offers no stable supported automation path for playback, the milestone
remains a documented manual claimed-mode check; private database injection is not
an acceptable substitute.

## Failure and diagnostic behavior

- Readiness has a bounded timeout per service and includes the last sanitized
  health response plus a command for viewing full local logs.
- Secrets, tokens, URLs containing credentials, usernames, and media titles are
  redacted from console output and Playwright artifacts.
- Screenshots, traces, and videos go to a gitignored harness artifact directory.
- A test failure preserves the stack for inspection. `down` is explicit rather
  than an unconditional test-finalizer.
- `reset` and purge verify ownership again immediately before mutation, avoiding
  a stale-preflight race.
- Bootstrap and Playwright do not accept arbitrary remote base URLs. The only
  override is a loopback address for this owned stack.

## Validation and review boundary

Implementation follows test-driven slices:

1. shell lifecycle and ownership tests;
2. Compose config validation and clean startup;
3. provider bootstrap and connection smoke tests;
4. Playwright provider-selection and outage tests; and
5. documentation and package-script integration.

During iteration, run the narrow lifecycle or Playwright test for the current
slice. Before the PR, run:

```bash
docker compose --project-name arr-dashboard-media-analytics-e2e \
  -f e2e/media-analytics/docker-compose.yml config --quiet
pnpm e2e:media-analytics:reset
pnpm e2e:media-analytics
pnpm run format
pnpm run typecheck
pnpm run test
pnpm run lint
pnpm run build
```

Run one independent supply-chain review for image pins, secrets, mounts, and
workflow boundaries, and one regression review for provider behavior. Inventory
their findings once and apply one bounded correction pass. A later observation
is follow-up work unless it proves the harness unsafe or invalid; it does not
restart the whole review loop.

## Acceptance criteria

- A clean machine with Docker and the repository dependencies installed can
  start the harness using the documented root command.
- Re-running `up` is idempotent, and `reset` creates a clean owned environment.
- Teardown and purge cannot select resources outside the explicit Compose
  project.
- No tracked file or normal command output contains a generated secret.
- Real Plex, Tautulli, and Tracearr connection tests pass.
- Provider selection, isolation, outage, recovery, and incognito assertions pass.
- Claimed mode clearly identifies its external-account requirement and never
  persists the short-lived claim token.
- The full repository gauntlet and production build pass.
- The PR distinguishes automated coverage from the deferred/manual playback
  history assertion and does not claim evidence it did not collect.
