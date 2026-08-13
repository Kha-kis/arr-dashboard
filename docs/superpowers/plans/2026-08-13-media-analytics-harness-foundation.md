# Media Analytics Harness Foundation Implementation Plan

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** Build and run the first independently useful media-analytics harness milestone: an ownership-safe, reusable Docker Compose stack that starts real Plex, Tautulli, Tracearr, and arr-dashboard services and proves their supported connection paths.

**Architecture:** A dedicated `e2e/media-analytics` Compose project owns every container, network, volume, generated secret, and synthetic-media artifact. Shell lifecycle code is exercised with a fake Docker CLI before it is allowed to invoke real Docker; real-service bootstrap then uses only supported HTTP and browser surfaces. Provider-selection behavior remains in the next plan because `next` does not yet contain the `analyticsProvider` runtime setting, and combining that application feature with infrastructure would invalidate the focused-PR boundary.

**Tech Stack:** Bash 5, Node.js `node:test`, Docker Compose, Plex Media Server, Tautulli, Tracearr, TimescaleDB, Redis, Playwright, pnpm.

## Global Constraints

- Use the exact Compose project name `arr-dashboard-media-analytics-e2e` for every Compose invocation.
- Bind every published port to `127.0.0.1`; provider-to-provider traffic uses private Compose service names.
- Use pinned image versions: Plex `plexinc/pms-docker:1.43.3.10861-07dfddaeb`, Tautulli `tautulli/tautulli:v2.17.2`, Tracearr `ghcr.io/connorgallopo/tracearr:2.0.1`, TimescaleDB `timescale/timescaledb-ha:pg18.4-ts2.29.1`, Redis `redis:8.2.2-alpine`, and FFmpeg `linuxserver/ffmpeg:8.1.2-cli-ls76`.
- Do not use `container_name`, `latest`, production endpoints, production credentials, or direct provider-database edits.
- Generated credentials and artifacts live below gitignored `e2e/media-analytics/.state/` with owner-only permissions.
- Destructive lifecycle operations resolve candidate resources immediately before mutation and reject any resource whose `com.docker.compose.project` label differs from the expected project.
- `PLEX_CLAIM` and `PLEX_TOKEN` are optional, invocation-only, never written to disk, and never printed. Claimed mode requires both because Plex does not expose a supported endpoint that recovers the server token produced by claim exchange.
- Local Plex mode uses only the dedicated private Compose subnet. If supported connection APIs reject unclaimed Plex, fail with an actionable claimed-mode instruction; never fabricate success.
- A running container is not proof of readiness. Each real service must answer its health or supported API check.
- This plan does not add skipped or expected-failing provider-selection tests. Those land with the provider-selection runtime in the next focused plan.
- Apply TDD to lifecycle behavior: write and observe each failing `node:test` case before writing the shell implementation.
- Assemble the coherent implementation before independent review. Run one supply-chain review and one regression review, inventory findings once, and use one bounded correction pass.

---

### Task 1: Runtime-tested ownership-safe lifecycle

**Files:**
- Create: `e2e/media-analytics/tests/lifecycle.test.mjs`
- Create: `e2e/media-analytics/scripts/common.sh`
- Create: `e2e/media-analytics/scripts/preflight.sh`
- Create: `e2e/media-analytics/scripts/reset.sh`
- Create: `e2e/media-analytics/scripts/teardown.sh`
- Modify: `package.json`

**Interfaces:**
- Produces shell functions `compose()`, `require_command()`, `assert_loopback_url()`, `owned_resource_ids()`, and `assert_owned_resources()` in `common.sh`.
- Produces commands `pnpm e2e:media-analytics:lifecycle-test`, `pnpm e2e:media-analytics:reset`, `pnpm e2e:media-analytics:down`, and `pnpm e2e:media-analytics:purge`.
- `teardown.sh` consumes `PURGE_VOLUMES=0|1`; normal down retains volumes, purge removes verified volumes.

- [ ] **Step 1: Write the failing lifecycle tests**

Create a Node test that builds a temporary fake `docker` executable, prepends it
to `PATH`, records argv in `DOCKER_CALL_LOG`, and returns label data from
`DOCKER_FAKE_RESOURCES`. Cover these observable behaviors:

```javascript
test("down uses the explicit project and retains volumes", () => {
  const result = runScript("teardown.sh", { DOCKER_FAKE_RESOURCES: ownedFixture });
  assert.equal(result.status, 0);
  assert.match(readCalls(), /compose --project-name arr-dashboard-media-analytics-e2e down --remove-orphans/);
  assert.doesNotMatch(readCalls(), / -v(?: |$)/);
});

test("purge rejects a foreign labeled resource before compose down", () => {
  const result = runScript("teardown.sh", {
    PURGE_VOLUMES: "1",
    DOCKER_FAKE_RESOURCES: foreignFixture,
  });
  assert.notEqual(result.status, 0);
  assert.match(result.stderr, /refusing to mutate/i);
  assert.doesNotMatch(readCalls(), /compose .* down/);
});

test("preflight rejects a non-loopback dashboard URL", () => {
  const result = runScript("preflight.sh", { DASHBOARD_URL: "https://example.com" });
  assert.notEqual(result.status, 0);
  assert.match(result.stderr, /loopback/i);
});
```

- [ ] **Step 2: Run the tests and verify RED**

Run:

```bash
node --test e2e/media-analytics/tests/lifecycle.test.mjs
```

Expected: FAIL because the lifecycle scripts do not exist.

- [ ] **Step 3: Implement the minimal lifecycle**

Implement `common.sh` with these fixed values and behavior:

```bash
readonly COMPOSE_PROJECT="arr-dashboard-media-analytics-e2e"
readonly COMPOSE_FILE="${HARNESS_DIR}/docker-compose.yml"

compose() {
  docker compose --project-name "$COMPOSE_PROJECT" --file "$COMPOSE_FILE" "$@"
}
```

`owned_resource_ids` resolves containers, networks, and volumes selected by the
exact Compose project label. `assert_owned_resources` inspects every returned ID
again and compares the exact label immediately before mutation. Empty resource
sets are valid; malformed inspect output or a foreign/missing label fails.

`preflight.sh` requires `docker`, `curl`, `jq`, `openssl`, and Compose; accepts
only `http://127.0.0.1:<port>` or `http://localhost:<port>` for published URLs;
creates `.state` with mode `0700`; and validates `docker compose config --quiet`.

`reset.sh` runs preflight, invokes `teardown.sh` with `PURGE_VOLUMES=1`, and then
calls the later `bootstrap.sh`. Until Task 3 adds bootstrap, it exits with the
clear message `bootstrap.sh is not installed yet` after safe teardown.

- [ ] **Step 4: Run the lifecycle tests and verify GREEN**

Run:

```bash
node --test e2e/media-analytics/tests/lifecycle.test.mjs
```

Expected: all lifecycle tests PASS and the fake command log proves no destructive
Compose call occurs for a foreign resource.

- [ ] **Step 5: Add package commands and commit**

Add root package scripts that invoke only the checked-in scripts, then run:

```bash
git add package.json e2e/media-analytics
git commit -m "test: add safe media analytics lifecycle"
```

### Task 2: Pinned isolated Compose stack and synthetic media

**Files:**
- Create: `e2e/media-analytics/docker-compose.yml`
- Create: `e2e/media-analytics/.env.example`
- Create: `e2e/media-analytics/fixtures/generate-media.sh`
- Create: `e2e/media-analytics/tests/compose.test.mjs`
- Modify: `.gitignore`
- Modify: `e2e/media-analytics/scripts/preflight.sh`

**Interfaces:**
- Compose services are named `plex`, `tautulli`, `tracearr`, `tracearr-db`, `tracearr-redis`, `arr-dashboard`, and `media-generator`.
- Host ports are `PLEX_PORT=32400`, `TAUTULLI_PORT=38181`, `TRACEARR_PORT=33000`, `DASHBOARD_PORT=33030`, and `DASHBOARD_API_PORT=33031` by default.
- `generate-media.sh OUTPUT_DIR` creates `Synthetic Test/Synthetic Test.mp4` without network input.

- [ ] **Step 1: Write the failing Compose behavior tests**

The Node test invokes real `docker compose ... config --format json` when Docker
Compose is available and asserts parsed behavior rather than source text:

```javascript
assert.deepEqual(Object.keys(config.services).sort(), [
  "arr-dashboard", "media-generator", "plex", "tautulli",
  "tracearr", "tracearr-db", "tracearr-redis",
]);
for (const service of Object.values(config.services)) {
  assert.equal("container_name" in service, false);
}
assert.equal(config.services.plex.ports[0].host_ip, "127.0.0.1");
assert.equal(config.services.tautulli.ports[0].host_ip, "127.0.0.1");
assert.equal(config.services.tracearr.ports[0].host_ip, "127.0.0.1");
```

Also assert exact image values from the parsed model and verify that
`generate-media.sh` creates a non-empty MP4 in a temporary directory when its
pinned generator container is available.

- [ ] **Step 2: Run the tests and verify RED**

Run:

```bash
node --test e2e/media-analytics/tests/compose.test.mjs
```

Expected: FAIL because the Compose model and generator do not exist.

- [ ] **Step 3: Implement the minimal stack**

Build arr-dashboard from the repository Dockerfile with a disposable named
volume at `/config`. Mount generated media read-only at `/data`. Configure Plex
bridge mode with `ALLOWED_NETWORKS` limited to the Compose subnet and pass
`PLEX_CLAIM` only from the current environment. Mount Plex configuration,
Tautulli configuration, Tracearr backups, TimescaleDB data, Redis data, and
arr-dashboard configuration in project-owned named volumes.

Use healthchecks that call the service locally. Tracearr depends on healthy
TimescaleDB and Redis. Tautulli and Tracearr depend on Plex being reachable, but
their application setup remains the responsibility of bootstrap rather than
container startup.

Generate a two-second color-bar MP4 with
`linuxserver/ffmpeg:8.1.2-cli-ls76` in the
`media-generator` profile. The script validates the output path is beneath the
harness `.state/media` root before replacing generated content.

- [ ] **Step 4: Run parsed Compose and media tests and verify GREEN**

Run:

```bash
node --test e2e/media-analytics/tests/compose.test.mjs
docker compose --project-name arr-dashboard-media-analytics-e2e \
  --file e2e/media-analytics/docker-compose.yml config --quiet
```

Expected: PASS with no floating image, external bind, fixed container name, or
unresolved required variable.

- [ ] **Step 5: Commit the stack**

```bash
git add .gitignore e2e/media-analytics
git commit -m "test: add pinned media analytics stack"
```

### Task 3: Idempotent secrets, readiness, and real provider bootstrap

**Files:**
- Create: `e2e/media-analytics/scripts/generate-secrets.sh`
- Create: `e2e/media-analytics/scripts/wait-for-services.sh`
- Create: `e2e/media-analytics/scripts/bootstrap.sh`
- Create: `e2e/media-analytics/tests/bootstrap.test.mjs`
- Modify: `e2e/media-analytics/scripts/reset.sh`
- Modify: `e2e/media-analytics/docker-compose.yml`

**Interfaces:**
- `.state/runtime.env` contains only generated non-production values and has mode `0600`.
- `.state/bootstrap.json` contains `schemaVersion: 1`, service mode, and sanitized bootstrap state; it contains no token or password.
- `wait_for_http NAME URL EXPECTED_STATUS ATTEMPTS INTERVAL_SECONDS` is the bounded readiness primitive.
- `bootstrap.sh` exits `0` only after each real service and arr-dashboard connection check succeeds.

- [ ] **Step 1: Write failing bootstrap tests**

Use fake `curl` and `docker` executables to exercise supported response sequences:

```javascript
test("secret generation is idempotent and stores mode 0600", () => {
  runScript("generate-secrets.sh");
  const first = readFileSync(runtimeEnv, "utf8");
  runScript("generate-secrets.sh");
  assert.equal(readFileSync(runtimeEnv, "utf8"), first);
  assert.equal(statSync(runtimeEnv).mode & 0o777, 0o600);
  assert.doesNotMatch(first, /PLEX_CLAIM/);
});

test("readiness fails after the bounded final attempt", () => {
  const result = runScript("wait-for-services.sh", { CURL_SEQUENCE: "503,503,503" });
  assert.notEqual(result.status, 0);
  assert.match(result.stderr, /did not become ready/i);
});

test("bootstrap never marks completion after a failed connection test", () => {
  const result = runScript("bootstrap.sh", { CONNECTION_RESULT: "failure" });
  assert.notEqual(result.status, 0);
  assert.equal(existsSync(bootstrapJson), false);
});
```

- [ ] **Step 2: Run the tests and verify RED**

Run:

```bash
node --test e2e/media-analytics/tests/bootstrap.test.mjs
```

Expected: FAIL because bootstrap scripts do not exist.

- [ ] **Step 3: Implement generated state and readiness**

Generate 64-hex Tracearr JWT/cookie secrets, a database password, a 32-character
Tautulli API key, a local-mode Plex placeholder token, an arr-dashboard administrator
password, and API-test state with `openssl rand`.
Never echo values. Source `.state/runtime.env` only after validating owner-only
permissions. Wait on Plex `/identity`, Tautulli `/status`, Tracearr `/health`,
and arr-dashboard `/health`, using a
bounded loop whose timeout names the failed service.

- [ ] **Step 4: Implement supported bootstrap flows and observe real behavior**

Start Plex first, inspect `/identity`, and use its observed machine identifier
when starting downstream services. In local mode, probe from the dedicated
allowed subnet without a token first; the generated placeholder is supplied only
to clients whose schemas require a non-empty value, and success is treated as an
observed local-mode compatibility result rather than a documented Plex token
contract. In claimed mode, require invocation-only `PLEX_CLAIM` and `PLEX_TOKEN`
before startup. Configure the synthetic library through Plex's supported HTTP
setup flow only when the authenticated management call is available.

Configure Tautulli non-interactively with its
supported `TAUTULLI_FIRST_RUN_COMPLETE`, `TAUTULLI_PMS_TOKEN`,
`TAUTULLI_PMS_IDENTIFIER`, `TAUTULLI_PMS_IP`, `TAUTULLI_PMS_PORT`,
`TAUTULLI_PMS_URL_MANUAL`, `TAUTULLI_API_ENABLED`, and `TAUTULLI_API_KEY`
environment overrides. Require
`/api/v2?apikey=<key>&cmd=server_status` to report `connected: true`.

For Tracearr, call unauthenticated `GET /api/v1/setup/status`, create the first
owner through `POST /api/v1/auth/sign-up/email` while preserving its Better Auth
session cookie, connect Plex through authenticated `POST /api/v1/servers`, and
obtain arr-dashboard's read-only key through authenticated
`POST /api/v1/settings/api-key/regenerate`. Require the key to start with
`trr_pub_` and verify it against `GET /api/v2/public/docs` with an
`Authorization: Bearer` header. Do not edit SQLite or PostgreSQL files.

Register the arr-dashboard administrator through `/auth/register`, log in through
the public auth route, create the three service instances with `/api/services`,
and require `{ success: true }` from `/api/services/:id/test` for Plex, Tautulli,
and Tracearr. If unclaimed Plex rejects any supported connection, exit with:

```text
Local Plex mode cannot complete the real provider connection flow with this
upstream version. Re-run once with PLEX_CLAIM=claim-... pnpm
e2e:media-analytics:reset; the claim value is not persisted.
```

- [ ] **Step 5: Run fake tests, then run the real stack**

Run:

```bash
node --test e2e/media-analytics/tests/bootstrap.test.mjs
pnpm e2e:media-analytics:reset
```

Expected: fake behavior tests PASS. The real reset either completes all three
connection tests or fails at the exact unsupported upstream flow with the
claimed-mode instruction; it must not mark bootstrap complete on partial setup.

- [ ] **Step 6: Commit bootstrap**

```bash
git add e2e/media-analytics
git commit -m "test: bootstrap real media analytics providers"
```

### Task 4: Connection smoke, reusable operation, and documentation

**Files:**
- Create: `e2e/media-analytics/playwright.config.ts`
- Create: `e2e/media-analytics/fixtures/setup.setup.ts`
- Create: `e2e/media-analytics/specs/connections.spec.ts`
- Create: `e2e/media-analytics/README.md`
- Modify: `package.json`
- Modify: `e2e/media-analytics/scripts/bootstrap.sh`

**Interfaces:**
- Playwright reads only `.state/runtime.env` and stores auth beneath `.state/playwright/`.
- `pnpm e2e:media-analytics` runs the real connection and setup-copy smoke tests against `http://127.0.0.1:33030`.
- `README.md` documents local mode, invocation-only claimed mode, down, reset, purge, diagnostics, resource cost, and the explicit provider-selection follow-up boundary.

- [ ] **Step 1: Write the Playwright smoke spec before changing setup**

The setup project creates/logs into the disposable administrator and saves auth.
The smoke project asserts:

```typescript
for (const label of ["E2E Plex", "E2E Tautulli", "E2E Tracearr"]) {
  await expect(page.getByText(label, { exact: true })).toBeVisible();
}
await expect(page.getByText(/Tracearr is recommended for new analytics setups/i)).toBeVisible();
await expect(page.getByText(/Tautulli remains a supported alternative/i)).toBeVisible();
await expect(page.getByText(/Choose one historical analytics provider/i)).toBeVisible();
```

The test must use real arr-dashboard responses; it does not intercept provider or
service APIs.

- [ ] **Step 2: Run Playwright and verify RED**

Run:

```bash
pnpm exec playwright test --config=e2e/media-analytics/playwright.config.ts
```

Expected: FAIL until the setup fixture, state path, and package command exist.

- [ ] **Step 3: Implement setup fixture and reusable commands**

Adapt the existing integration setup pattern while requiring, rather than merely
logging, successful connection tests. Make repeated execution idempotent by
matching exact service labels. Configure Playwright for one worker, retained
traces/screenshots/videos on failure, and artifact paths under `.state`.

Add:

```json
"e2e:media-analytics:up": "bash e2e/media-analytics/scripts/bootstrap.sh",
"e2e:media-analytics": "playwright test --config=e2e/media-analytics/playwright.config.ts"
```

- [ ] **Step 4: Run the real smoke and document observed limitations**

Run:

```bash
pnpm e2e:media-analytics
pnpm e2e:media-analytics:down
pnpm e2e:media-analytics:up
pnpm e2e:media-analytics
```

Expected: both first and resumed runs PASS without regenerating credentials.
Document only behavior actually observed. If claimed mode is required, state that
as a prerequisite and include the exact invocation without recording a token.

- [ ] **Step 5: Run repository validation**

```bash
pnpm run format
pnpm run typecheck
pnpm run test
pnpm run lint
pnpm run build
git diff --check
```

Expected: all checks PASS.

- [ ] **Step 6: Commit the coherent harness**

```bash
git add package.json e2e/media-analytics
git commit -m "test: verify real media analytics connections"
```

### Task 5: Consolidated review and handoff

**Files:**
- Modify only files identified by the consolidated finding inventory.

**Interfaces:**
- Supply-chain review covers image provenance/pins, credentials, mounts, network exposure, and destructive lifecycle boundaries.
- Regression review covers idempotency, real connection assertions, failure honesty, and existing E2E/package command compatibility.

- [ ] **Step 1: Dispatch both independent read-only reviews once**

Give each reviewer the complete diff from the branch base through `HEAD`, this
plan, the design specification, and the validation report. Do not dispatch review
after each small correction.

- [ ] **Step 2: Record one finding inventory**

Classify each finding as accepted, rejected with evidence, or follow-up. Only an
accepted finding that makes the current harness unsafe or invalid enters the
correction pass.

- [ ] **Step 3: Apply one bounded correction pass**

Use one worker to address the complete accepted inventory, add or amend the
specific failing tests first, and rerun the focused lifecycle/Compose/bootstrap
tests plus every repository gate affected by the fix.

- [ ] **Step 4: Run one scoped re-review and final verification**

The reviewers inspect only the correction diff against the recorded findings.
New observations outside corrected lines become follow-up work unless they prove
the branch unsafe or invalid. Then rerun the real connection smoke and full
gauntlet before preparing the PR.
