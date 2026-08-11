# Library Cleanup Harness Stabilization Implementation Plan

> **Issue:** #690  
> **Base:** `origin/main`  
> **Branch:** `codex/690-stabilize-cleanup-harness`  
> **Design:** `docs/plans/2026-08-10-library-cleanup-harness-stabilization-design.md`

## Goal

Make the disposable Library Cleanup harness reproducible and able to complete
clean SQLite and PostgreSQL runs without weakening any production identity,
ownership, or deletion safeguard.

## Task 1: Lock the Compose execution contract

**Files:**

- Create `e2e/library-cleanup/compose-command.sh`
- Create `e2e/library-cleanup/compose-command.test.sh`
- Modify every `e2e/library-cleanup/*.sh` script that invokes Compose
- Modify `e2e/library-cleanup/README.md`

**Steps:**

1. Add failing tests using a temporary fake `ARR_COMPOSE_BIN` that assert the
   exact project, base/debug files, profiles, and forwarded subcommand.
2. Add a static test that rejects direct `docker compose`, local `COMPOSE_BIN`,
   or private `compose()` wrappers outside the shared helper.
3. Run `sh e2e/library-cleanup/compose-command.test.sh` and confirm failure.
4. Implement the POSIX helper with exact executable validation and fixed file
   paths.
5. Migrate validation, bootstrap, browser, scenario, build, and teardown paths.
6. Preserve teardown confirmation and validation before any `down` command.
7. Rerun the focused test and `sh e2e/library-cleanup/validate-compose.sh`.

## Task 2: Pin and validate integration-image defaults

**Files:**

- Modify `e2e/library-cleanup/.env.example`
- Modify `e2e/library-cleanup/compose.yml`
- Modify `e2e/library-cleanup/check-compose-model.py`
- Modify `e2e/library-cleanup/README.md`

**Steps:**

1. Add negative model self-tests for mutable Radarr, Sonarr, Plex, and
   qBittorrent defaults.
2. Resolve immutable multi-architecture digests for the locally tested image
   set and verify their manifests.
3. Replace checked-in `latest` defaults with those immutable references.
4. Add exact allowlists or immutable-reference validation for the four
   integration service groups while retaining explicit environment overrides
   for compatibility experiments.
5. Verify positive and negative Compose model tests.

## Task 3: Restore stable Plex history identity

**Files:**

- Modify `e2e/library-cleanup/compose.yml`
- Modify `e2e/library-cleanup/bootstrap-plex.test.mjs`

**Steps:**

1. Add a test that extracts or requests the bridge history fixture and requires
   a non-empty stable `historyKey` alongside `ratingKey`.
2. Confirm the test fails against the current fixture.
3. Add one deterministic unique `historyKey` to the loopback row.
4. Rerun Plex and Compose model tests.

## Task 4: Authenticate qBittorrent fixture setup

**Files:**

- Modify `e2e/library-cleanup/bootstrap-torrents.mjs`
- Modify `e2e/library-cleanup/bootstrap-torrents.test.mjs`
- Modify `e2e/library-cleanup/bootstrap-torrents.sh`

**Steps:**

1. Add mocked-fetch tests for successful login, required SID cookie,
   authenticated torrent lookup/add/verification, rejected credentials,
   401/403 diagnostics, and secret redaction.
2. Confirm the new tests fail.
3. Implement a per-service session helper that logs in using environment-only
   disposable credentials and attaches the returned cookie to every request.
4. Extract each temporary password through the shared Compose path and pass it
   only into the isolated runner process.
5. Rerun torrent tests and ensure output contains no password values.

## Task 5: Make ARR fixture convergence deterministic

**Files:**

- Modify `e2e/library-cleanup/bootstrap-arr.mjs`
- Modify `e2e/library-cleanup/bootstrap-arr.test.mjs`
- Modify `e2e/library-cleanup/README.md`

**Steps:**

1. Add pure classification tests for absent, freshly associated, detached,
   duplicate-controlled, malformed, and foreign-path file states.
2. Add request-level tests proving normalization uses only the exact fixture
   external ID, item path, file path, and safe integer IDs.
3. Confirm these tests fail before implementation.
4. Reuse a single valid attached file without rescanning.
5. For an absent fixture, add it and wait for initial import before rescanning.
6. For stale or duplicate state wholly inside the controlled fixture, remove
   only that fixture's ARR database entry with file deletion disabled, verify
   absence, re-add it, and require one freshly associated row.
7. Fail before mutation on any ambiguous ownership or path and fail if
   convergence still yields zero or multiple rows.
8. Rerun ARR tests twice to verify idempotent behavior.

## Task 6: Focused harness verification

**Commands:**

```sh
node --test e2e/library-cleanup/bootstrap-arr.test.mjs
node --test e2e/library-cleanup/bootstrap-plex.test.mjs
node --test e2e/library-cleanup/bootstrap-torrents.test.mjs
sh e2e/library-cleanup/compose-command.test.sh
sh e2e/library-cleanup/provenance-helpers.test.sh
sh e2e/library-cleanup/validate-compose.sh
```

Run `git diff --check`, inspect the full branch diff, and remove any generated
files or secrets.

## Task 7: Independent safety and regression reviews

1. Delegate the completed diff read-only to the required
   `data_safety_reviewer` agent.
2. Delegate a separate read-only pass to `regression_reviewer`.
3. Classify each finding against #690 scope before changing code.
4. Fix only demonstrated correctness, safety, or regression defects; record
   unrelated suggestions for later rather than expanding the PR.
5. Rerun only the affected focused tests after each accepted finding.

## Task 8: Repository gauntlet and clean live acceptance

**Commands:**

```sh
pnpm run format
pnpm run typecheck
pnpm run test
pnpm run lint
pnpm run build
```

Then create a fresh unique `lc-e2e-*` project using ignored temporary secrets,
build the candidate from the clean checkout, and run the documented bootstrap
and scenario sequence against SQLite and PostgreSQL. Capture resolved image
identities and exact diagnostics under the ignored artifact directory.

Finally, run guarded teardown for the exact project name, confirm only the
disposable project volumes were removed, and reassess PR readiness with
`arr-validate` and `arr-prepare-pr`.

