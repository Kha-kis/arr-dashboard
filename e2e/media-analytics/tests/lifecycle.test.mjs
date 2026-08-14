import assert from "node:assert/strict";
import { existsSync, mkdtempSync, mkdirSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join, resolve } from "node:path";
import { spawn, spawnSync } from "node:child_process";
import test from "node:test";

const harnessDir = resolve("e2e/media-analytics");
const scriptsDir = join(harnessDir, "scripts");
const lockFixture = join(harnessDir, "tests/fixtures/lifecycle-lock.sh");
const projectLabel = "arr-dashboard-media-analytics-e2e";
const ownedFixture = [
  `container:owned-container:${projectLabel}`,
  `network:owned-network:${projectLabel}`,
  `volume:owned-volume:${projectLabel}`,
].join("\n");
const foreignFixture = [
  `container:owned-container:${projectLabel}`,
  "volume:foreign-volume:someone-elses-project",
].join("\n");

let sandboxDir;
let dockerCallLog;
let fakeDaemonId;

function writeFakeDocker(binDir) {
  const fakeDocker = join(binDir, "docker");
  writeFileSync(
    fakeDocker,
    `#!/usr/bin/env bash
set -euo pipefail
printf '%s ' "$@" >> "$DOCKER_CALL_LOG"
printf '\\n' >> "$DOCKER_CALL_LOG"

resources="\${DOCKER_FAKE_RESOURCES:-}"

case "\${1:-}" in
  info)
    printf '%s' "\${DOCKER_FAKE_DAEMON_ID:?}"
    ;;
  ps)
    [[ "\${DOCKER_FAIL_LIST_KIND:-}" != "container" ]] || exit 42
    awk -F: -v kind="container" '$1 == kind { print $2 }' <<< "$resources"
    ;;
  network|volume)
    resource_type="$1"
    if [[ "\${2:-}" == "inspect" ]]; then
      resource_id="\${@: -1}"
      awk -F: -v kind="$resource_type" -v id="$resource_id" '$1 == kind && $2 == id { print $3; found = 1 } END { if (!found) exit 1 }' <<< "$resources"
    else
      [[ "\${DOCKER_FAIL_LIST_KIND:-}" != "$resource_type" ]] || exit 42
      awk -F: -v kind="$resource_type" '$1 == kind { print $2 }' <<< "$resources"
    fi
    ;;
  inspect)
    resource_id="\${@: -1}"
    awk -F: -v id="$resource_id" '$2 == id { print $3; found = 1 } END { if (!found) exit 1 }' <<< "$resources"
    ;;
  container)
    resource_type="$1"
    resource_id="\${@: -1}"
    awk -F: -v kind="$resource_type" -v id="$resource_id" '$1 == kind && $2 == id { print $3; found = 1 } END { if (!found) exit 1 }' <<< "$resources"
    ;;
  compose)
    exit 0
    ;;
  *)
    exit 0
    ;;
esac
`,
    { mode: 0o755 },
  );
}

function runScript(scriptName, extraEnv = {}) {
  const result = spawnSync("bash", [join(scriptsDir, scriptName)], {
    cwd: harnessDir,
    encoding: "utf8",
    env: {
      ...process.env,
      ...extraEnv,
      DOCKER_CALL_LOG: dockerCallLog,
      DOCKER_FAKE_DAEMON_ID: fakeDaemonId,
      XDG_RUNTIME_DIR: join(sandboxDir, "runtime"),
      PATH: `${join(sandboxDir, "bin")}:${process.env.PATH}`,
    },
  });

  return result;
}

function readCalls() {
  return readFileSync(dockerCallLog, "utf8");
}

test.beforeEach(() => {
  sandboxDir = mkdtempSync(join(tmpdir(), "media-analytics-lifecycle-"));
  fakeDaemonId = `fake-${process.pid}-${sandboxDir.slice(-6)}`;
  const binDir = join(sandboxDir, "bin");
  mkdirSync(binDir);
  mkdirSync(join(sandboxDir, "runtime"), { mode: 0o700 });
  dockerCallLog = join(sandboxDir, "docker-calls.log");
  writeFileSync(dockerCallLog, "");
  writeFakeDocker(binDir);
});

test.afterEach(() => {
  rmSync(`/tmp/${projectLabel}-${process.getuid()}-${fakeDaemonId}`, { recursive: true, force: true });
  rmSync(sandboxDir, { recursive: true, force: true });
});

test("down uses the explicit project and retains volumes", () => {
  const result = runScript("teardown.sh", { DOCKER_FAKE_RESOURCES: ownedFixture });
  assert.equal(result.status, 0);
  assert.match(
    readCalls(),
    /compose --project-name arr-dashboard-media-analytics-e2e --file \S+\/docker-compose\.yml down --remove-orphans/,
  );
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

test("down revalidates every resource with its type-specific label field", () => {
  const result = runScript("teardown.sh", { DOCKER_FAKE_RESOURCES: ownedFixture });
  assert.equal(result.status, 0);

  const calls = readCalls();
  assert.match(calls, /container inspect --format \{\{ index \.Config\.Labels "com\.docker\.compose\.project" \}\} owned-container/);
  assert.match(calls, /network inspect --format \{\{ index \.Labels "com\.docker\.compose\.project" \}\} owned-network/);
  assert.match(calls, /volume inspect --format \{\{ index \.Labels "com\.docker\.compose\.project" \}\} owned-volume/);
});

for (const resourceType of ["container", "network", "volume"]) {
  test(`down fails closed when ${resourceType} enumeration fails`, () => {
    const result = runScript("teardown.sh", {
      DOCKER_FAKE_RESOURCES: ownedFixture,
      DOCKER_FAIL_LIST_KIND: resourceType,
    });

    assert.notEqual(result.status, 0);
    assert.match(result.stderr, /unable to list compose resources/i);
    assert.doesNotMatch(readCalls(), /compose .* down/);
  });
}

test("teardown cannot bypass another worktree lock with a different runtime environment", async () => {
  const marker = join(sandboxDir, "lock-held");
  const holder = spawn("bash", [lockFixture, "hold", marker], {
    cwd: harnessDir,
    env: {
      ...process.env,
      DOCKER_CALL_LOG: dockerCallLog,
      DOCKER_FAKE_DAEMON_ID: fakeDaemonId,
      XDG_RUNTIME_DIR: "",
      PATH: `${join(sandboxDir, "bin")}:${process.env.PATH}`,
    },
  });

  for (let attempt = 0; attempt < 50 && !existsSync(marker); attempt += 1) {
    await new Promise((resolveWait) => setTimeout(resolveWait, 20));
  }
  assert.equal(existsSync(marker), true, "lifecycle lock holder did not start");

  const result = runScript("teardown.sh", { DOCKER_FAKE_RESOURCES: ownedFixture });
  assert.notEqual(result.status, 0);
  assert.match(result.stderr, /lifecycle operation is already running/i);
  assert.doesNotMatch(readCalls(), /compose .* down/);

  await new Promise((resolveChild) => holder.on("close", resolveChild));
});

test("a reset can carry the lifecycle lock across nested scripts", () => {
  const result = spawnSync("bash", [lockFixture, "nested-parent"], {
    cwd: harnessDir,
    encoding: "utf8",
    env: {
      ...process.env,
      DOCKER_CALL_LOG: dockerCallLog,
      DOCKER_FAKE_DAEMON_ID: fakeDaemonId,
      XDG_RUNTIME_DIR: join(sandboxDir, "runtime"),
      PATH: `${join(sandboxDir, "bin")}:${process.env.PATH}`,
    },
  });

  assert.equal(result.status, 0, result.stderr);
});

test("reset validates claim inputs before deleting retained volumes", () => {
  const missingClaim = runScript("reset.sh", { DOCKER_FAKE_RESOURCES: ownedFixture });
  assert.notEqual(missingClaim.status, 0);
  assert.match(missingClaim.stderr, /requires.*PLEX_CLAIM/i);
  assert.doesNotMatch(readCalls(), /compose .* down/);

  writeFileSync(dockerCallLog, "");
  const forbiddenToken = runScript("reset.sh", {
    DOCKER_FAKE_RESOURCES: ownedFixture,
    PLEX_CLAIM: "claim-test",
    PLEX_TOKEN: "forbidden-token",
  });
  assert.notEqual(forbiddenToken.status, 0);
  assert.match(forbiddenToken.stderr, /PLEX_TOKEN is not accepted/i);
  assert.doesNotMatch(readCalls(), /compose .* down/);
});

test("preflight rejects a non-loopback dashboard URL", () => {
  const result = runScript("preflight.sh", { DASHBOARD_URL: "https://example.com" });
  assert.notEqual(result.status, 0);
  assert.match(result.stderr, /loopback/i);
});
