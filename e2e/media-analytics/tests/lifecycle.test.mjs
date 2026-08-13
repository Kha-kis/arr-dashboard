import assert from "node:assert/strict";
import { mkdtempSync, mkdirSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join, resolve } from "node:path";
import { spawnSync } from "node:child_process";
import test from "node:test";

const harnessDir = resolve("e2e/media-analytics");
const scriptsDir = join(harnessDir, "scripts");
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
  ps)
    awk -F: -v kind="container" '$1 == kind { print $2 }' <<< "$resources"
    ;;
  network)
    awk -F: -v kind="network" '$1 == kind { print $2 }' <<< "$resources"
    ;;
  volume)
    awk -F: -v kind="volume" '$1 == kind { print $2 }' <<< "$resources"
    ;;
  inspect)
    resource_id="\${@: -1}"
    awk -F: -v id="$resource_id" '$2 == id { print $3; found = 1 } END { if (!found) exit 1 }' <<< "$resources"
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
  const binDir = join(sandboxDir, "bin");
  mkdirSync(binDir);
  dockerCallLog = join(sandboxDir, "docker-calls.log");
  writeFileSync(dockerCallLog, "");
  writeFakeDocker(binDir);
});

test.afterEach(() => {
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

test("preflight rejects a non-loopback dashboard URL", () => {
  const result = runScript("preflight.sh", { DASHBOARD_URL: "https://example.com" });
  assert.notEqual(result.status, 0);
  assert.match(result.stderr, /loopback/i);
});
