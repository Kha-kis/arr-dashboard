# Library Cleanup Harness Stabilization Design

## Context

Issue #690 tracks compatibility drift in the disposable Library Cleanup live
harness. The observed failures are in fixture setup and command orchestration,
not in the production cleanup providers:

- the loopback Plex history response lacks a stable `historyKey`;
- current Radarr and Sonarr images can expose duplicate file rows after an
  unnecessary or stale-state rescan;
- qBittorrent now rejects unauthenticated bootstrap requests;
- harness scripts resolve Docker Compose through different command paths; and
- mutable integration image tags make a previously passing run irreproducible.

The harness exercises deletion-adjacent behavior, so setup must remain
fail-closed and must never weaken application identity or ownership checks.

## Scope

This change is limited to `e2e/library-cleanup` and its documentation. It will:

1. establish reproducible integration-image defaults;
2. make the Plex bridge fixture satisfy the application's stable-history-row
   contract;
3. make ARR fixture setup converge without arbitrarily choosing among
   duplicate rows;
4. authenticate every qBittorrent bootstrap request;
5. route all validation, bootstrap, scenario, browser, and teardown operations
   through one Compose command resolver; and
6. add focused tests plus clean SQLite and PostgreSQL live-run evidence.

Production cleanup, Radarr, Sonarr, Plex, and qUI client behavior is explicitly
out of scope unless the stabilized harness reproduces a separate application
defect.

## Image compatibility contract

The checked-in defaults for Radarr, Sonarr, Plex, and qBittorrent will use
immutable, multi-architecture image references rather than `latest`. Existing
environment overrides remain available for intentional compatibility runs.

Static validation will reject mutable checked-in defaults and the live run will
continue recording the resolved image identity. An override is treated as an
explicit test choice, not as evidence that the default compatibility set
passed.

## Shared Compose command path

A small POSIX shell helper will own Compose resolution and the fixed harness
file set. It will:

- use the exact executable supplied in `ARR_COMPOSE_BIN` when present;
- otherwise use the Docker Compose plugin available to the caller;
- apply the validated project name and the fixed base/debug Compose files; and
- forward only the requested Compose subcommand and arguments.

Every harness script, including validation and teardown, will invoke that
helper. Teardown retains its exact project-name confirmation and live model
validation before the helper can run `down --volumes --remove-orphans`.

Tests will exercise an injected fake Compose executable and statically assert
that no harness phase bypasses the helper.

## Plex history fixture

The loopback history row will receive a unique, stable `historyKey` whose value
is consistent across pagination calls. Existing completeness and stable-row
identity checks remain unchanged. A fixture-level test will prevent the field
from disappearing again.

## Deterministic ARR fixture convergence

The bootstrap will classify fixture state using all of the following:

- the exact isolated service URL;
- the known TMDb or TVDb identifier;
- the exact controlled item root and media path;
- safe integer item and file identifiers; and
- the parent movie or episode association to the matching file row.

If exactly one valid record is already attached to the expected parent, setup
will reuse it and skip a redundant rescan. If the controlled fixture is absent,
setup will add it and wait for its initial import before considering an explicit
rescan.

If stale or duplicate state belongs entirely to the exact controlled fixture,
the harness will rebuild that fixture's ARR database entry with file deletion
disabled, preserving the guarded hardlink, then re-add and verify it. It will
never select one duplicate merely by order or ID. Any unexpected path, parent,
external identifier, malformed ID, failed removal, or remaining duplicate
causes an explicit failure before a cleanup scenario can start.

This normalization is harness-only. The production application continues to
reject ambiguous ARR identities.

## Authenticated qBittorrent bootstrap

The shell bootstrap will read each disposable instance's temporary password
from that instance's container log. The password will be passed only as an
environment value to the isolated runner and will never be printed.

The Node bootstrap will create one authenticated session per qBittorrent
instance, retain the returned session cookie, and use it for torrent lookup,
add, and verification calls. Login success requires both an accepted status and
a session cookie. A 401/403 or malformed response will identify the service,
method, endpoint, and status without exposing credentials.

qUI's later subnet-whitelist setup remains independent; torrent setup no longer
depends on README ordering or unauthenticated access.

## Verification strategy

Implementation will be test-first. Focused tests will cover:

- fresh, already-valid, missing, stale, duplicate, and foreign ARR fixture
  states;
- refusal to normalize a path or identity outside the exact fixture boundary;
- qBittorrent login, cookie propagation, authentication failures, and redacted
  diagnostics;
- stable Plex `historyKey` presence;
- immutable checked-in image defaults; and
- Compose helper selection, fixed file/project arguments, teardown guarding,
  and the absence of direct bypasses.

After focused tests, the repository verification gauntlet will run. The final
acceptance test is a clean disposable environment that completes both SQLite
and PostgreSQL scenarios using the pinned defaults, with exact diagnostics and
image identities retained.

Because this is deletion-adjacent harness work, independent data-safety and
regression reviews are required before merge readiness is claimed.

