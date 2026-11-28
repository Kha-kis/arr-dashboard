import assert from "node:assert/strict";
import { spawnSync } from "node:child_process";
import {
	copyFileSync,
	existsSync,
	mkdtempSync,
	readFileSync,
	rmSync,
	writeFileSync,
} from "node:fs";
import { tmpdir } from "node:os";
import { delimiter, join } from "node:path";
import test from "node:test";

// Exercise the actual lifecycle script without a Docker daemon or upstream provider.
const fakeDocker = String.raw`#!/bin/sh
set -eu
case "$1" in
  compose)
    case "$6" in
      up) printf 'up\n' >> "$DOCKER_CALLS" ;;
      down) printf 'down\n' >> "$DOCKER_CALLS" ;;
      exec)
        case "$8" in
          jellyfin) echo '{"Version":"10.11.11"}' ;;
          lidarr) echo '{"version":"3.1.6.5079"}' ;;
          *) exit 2 ;;
        esac ;;
      *) exit 2 ;;
    esac ;;
  ps|volume|network)
    kind=$1
    [ "$kind" != ps ] || kind=container
    if [ "$2" = inspect ]; then
      printf '%s:%s\n' "$COMPOSE_PROJECT_NAME" "$PINNED_E2E_RUN_TOKEN"
      [ "$DOCKER_FAILURE" != "inspect-$kind" ]
    elif [ -s "$DOCKER_CALLS" ]; then
      [ "$DOCKER_FAILURE" != "list-$kind" ] || exit 1
      printf '%s-id\n' "$kind"
    fi ;;
  container)
    printf '%s:%s\n' "$COMPOSE_PROJECT_NAME" "$PINNED_E2E_RUN_TOKEN"
    [ "$DOCKER_FAILURE" != inspect-container ] ;;
  *) exit 2 ;;
esac`;

function runLifecycle(failure = "") {
	const dir = mkdtempSync(join(tmpdir(), "arr-pinned-lifecycle-"));
	try {
		copyFileSync(new URL("./run.sh", import.meta.url), join(dir, "run.sh"));
		writeFileSync(join(dir, "verify-images.sh"), "#!/bin/sh\nexit 0\n", { mode: 0o700 });
		writeFileSync(join(dir, "docker"), fakeDocker, { mode: 0o700 });
		const log = join(dir, "docker-calls");
		const result = spawnSync("sh", [join(dir, "run.sh")], {
			encoding: "utf8",
			timeout: 10_000,
			env: {
				...process.env,
				PATH: dir + delimiter + process.env.PATH,
				DOCKER_CALLS: log,
				DOCKER_FAILURE: failure,
			},
		});
		assert.ifError(result.error);
		return {
			...result,
			calls: existsSync(log) ? readFileSync(log, "utf8").trim().split("\n") : [],
		};
	} finally {
		rmSync(dir, { recursive: true, force: true });
	}
}

test("successful enumeration and ownership checks permit cleanup", () => {
	const result = runLifecycle();
	assert.equal(result.status, 0, result.stderr);
	assert.deepEqual(result.calls, ["up", "down"]);
});

for (const failure of ["list-container", "list-volume", "list-network", "inspect-container"]) {
	test(`an unsuccessful Docker command refuses cleanup for ${failure}`, () => {
		const result = runLifecycle(failure);
		assert.equal(result.status, 1);
		assert.deepEqual(result.calls, ["up"]);
		assert.match(result.stderr, /resources left untouched because ownership was uncertain/);
	});
}
