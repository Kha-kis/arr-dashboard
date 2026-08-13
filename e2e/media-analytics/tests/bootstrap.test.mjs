import assert from "node:assert/strict";
import { spawnSync } from "node:child_process";
import {
	cpSync,
	existsSync,
	mkdirSync,
	mkdtempSync,
	readFileSync,
	rmSync,
	statSync,
	writeFileSync,
} from "node:fs";
import { tmpdir } from "node:os";
import { join, resolve } from "node:path";
import test from "node:test";

const sourceHarnessDir = resolve("e2e/media-analytics");
const FAKE_TEST_TIMEOUT_MS = 5_000;
const FAKE_SCRIPT_TIMEOUT_MS = 3_000;

let harnessDir;
let sandboxDir;

function writeFakeDocker(binDir) {
	writeFileSync(
		join(binDir, "docker"),
		`#!/usr/bin/env bash
set -euo pipefail

if [[ "\${1:-}" == "compose" ]]; then
  if [[ " $* " == *" tautulli "* ]]; then
    [[ "\${TAUTULLI_FIRST_RUN_COMPLETE:-}" == "1" ]]
    [[ "\${TAUTULLI_PMS_URL_MANUAL:-}" == "1" ]]
    [[ "\${TAUTULLI_API_ENABLED:-}" == "1" ]]
    [[ "\${TAUTULLI_PMS_SSL:-}" == "0" ]]
  fi
  exit 0
fi

exit 0
`,
		{ mode: 0o755 },
	);
}

function writeFakeCurl(binDir) {
	writeFileSync(
		join(binDir, "curl"),
		`#!/usr/bin/env bash
set -euo pipefail

url=""
cookie_jar=""
cookie_input=""
request_data=""
for ((index = 1; index <= $#; index++)); do
  argument="\${!index}"
  if [[ "$argument" == http://* || "$argument" == https://* ]]; then
    url="$argument"
  fi
  case "$argument" in
    -c|--cookie-jar)
      next_index=$((index + 1))
      cookie_jar="\${!next_index}"
      ;;
    -b|--cookie)
      next_index=$((index + 1))
      cookie_input="\${!next_index}"
      ;;
    -d|--data|--data-raw|--data-binary)
      next_index=$((index + 1))
      request_data="\${!next_index}"
      ;;
  esac
done

printf '%s|jar=%s|cookie=%s\n' "$url" "$cookie_jar" "$cookie_input" >> "$CURL_CALL_LOG"

require_session() {
  if [[ -z "$cookie_input" || ! -s "$cookie_input" ]] || ! grep -q 'tracearr_session' "$cookie_input"; then
    return 1
  fi
}

require_json() {
  jq -e "$1" >/dev/null <<< "$request_data"
}

require_argument() {
  local expected="$1"
  shift
  for argument in "$@"; do
    [[ "$argument" == "$expected" ]] && return 0
  done
  return 1
}

status="200"
if [[ -n "\${CURL_SEQUENCE:-}" ]]; then
  state_file="\${CURL_SEQUENCE_STATE:?}"
  attempt=0
  if [[ -f "$state_file" ]]; then
    attempt="$(cat "$state_file")"
  fi
  attempt=$((attempt + 1))
  printf '%s' "$attempt" > "$state_file"
  IFS=',' read -r -a statuses <<< "$CURL_SEQUENCE"
  status="\${statuses[$((attempt - 1))]:-\${statuses[\${#statuses[@]} - 1]}}"
fi

if [[ " $* " == *" -w "* ]]; then
  printf '%s' "$status"
  exit 0
fi

if [[ "$status" != "200" && "$status" != "201" ]]; then
  exit 22
fi

case "$url" in
  */identity)
    identity_response="identity"
    if [[ -n "\${PLEX_IDENTITY_SEQUENCE:-}" ]]; then
      identity_state_file="\${PLEX_IDENTITY_SEQUENCE_STATE:?}"
      identity_attempt=0
      if [[ -f "$identity_state_file" ]]; then
        identity_attempt="$(cat "$identity_state_file")"
      fi
      identity_attempt=$((identity_attempt + 1))
      printf '%s' "$identity_attempt" > "$identity_state_file"
      IFS=',' read -r -a identity_responses <<< "$PLEX_IDENTITY_SEQUENCE"
      identity_response="\${identity_responses[$((identity_attempt - 1))]:-\${identity_responses[\${#identity_responses[@]} - 1]}}"
    fi
    if [[ "$identity_response" == "empty" ]]; then
      printf '%s' '{"MediaContainer":{}}'
    else
      printf '%s' '{"MediaContainer":{"machineIdentifier":"plex-machine-id"}}'
    fi
    ;;
  */api/v2\?apikey=*)
    printf '%s' '{"response":{"result":"success","data":{"connected":true}}}'
    ;;
  */api/v1/setup/status)
    printf '%s' '{"needsSetup":true,"requiresClaimCode":false}'
    ;;
  */api/v1/auth/sign-up/email)
    if [[ -z "$cookie_jar" ]]; then
      exit 22
    fi
    require_json '.username == "media-analytics" and .name == "Media Analytics" and .email == "media-analytics@example.test" and (.password | type == "string" and length > 0)' || exit 22
    printf '%s\n' 'tracearr_session=owner-session' > "$cookie_jar"
    printf '%s' '{"user":{"id":"tracearr-owner"}}'
    ;;
  */api/v1/servers)
    require_session || exit 22
    require_json '.type == "plex" and .name == "E2E Plex" and .url == "http://plex:32400" and (.token | type == "string" and length > 0)' || exit 22
    printf '%s' '{"id":"tracearr-server"}'
    ;;
  */api/v1/settings/api-key/regenerate)
    require_session || exit 22
    printf '%s' '{"token":"trr_pub_test_key"}'
    ;;
  */api/v2/public/docs)
    if [[ " $* " != *" Authorization: Bearer trr_pub_test_key "* ]]; then
      exit 22
    fi
    printf '%s' '{}'
    ;;
  */system/agents\?mediaType=1)
    printf '%s' '<MediaContainer><Directory identifier="tv.plex.agents.movie" /></MediaContainer>'
    ;;
  */library/sections)
    require_argument 'name=Synthetic Test' "$@" || exit 22
    require_argument 'type=1' "$@" || exit 22
    require_argument 'agent=tv.plex.agents.movie' "$@" || exit 22
    require_argument 'language=en-US' "$@" || exit 22
    require_argument 'locations=/data' "$@" || exit 22
    printf '%s' '{}'
    ;;
  */auth/register|*/auth/login)
    printf '%s' '{"success":true}'
    ;;
  */api/services/*/test)
    if [[ "\${CONNECTION_RESULT:-success}" == "failure" ]]; then
      printf '%s' '{"success":false}'
    else
      printf '%s' '{"success":true}'
    fi
    ;;
  */api/services)
    printf '%s' '{"service":{"id":"service-id"}}'
    ;;
  *)
    printf '%s' '{}'
    ;;
esac
`,
		{ mode: 0o755 },
	);
}

function runScript(scriptName, extraEnv = {}) {
	return spawnSync("bash", [join(harnessDir, "scripts", scriptName)], {
		cwd: harnessDir,
		encoding: "utf8",
		timeout: FAKE_SCRIPT_TIMEOUT_MS,
		killSignal: "SIGKILL",
		env: {
			...process.env,
			READINESS_ATTEMPTS: "1",
			READINESS_INTERVAL_SECONDS: "0",
			PLEX_IDENTITY_ATTEMPTS: "1",
			PLEX_IDENTITY_INTERVAL_SECONDS: "0",
			...extraEnv,
			CURL_CALL_LOG: join(sandboxDir, "curl-calls.log"),
			PLEX_IDENTITY_SEQUENCE_STATE: join(sandboxDir, "plex-identity-sequence-state"),
			CURL_SEQUENCE_STATE: join(sandboxDir, "curl-sequence-state"),
			PATH: `${join(sandboxDir, "bin")}:${process.env.PATH}`,
		},
	});
}

test.beforeEach(() => {
	sandboxDir = mkdtempSync(join(tmpdir(), "media-analytics-bootstrap-"));
	const harnessParentDir = join(sandboxDir, "harness");
	mkdirSync(harnessParentDir);
	cpSync(sourceHarnessDir, harnessParentDir, {
		recursive: true,
		filter: (source) => !source.endsWith("/.state"),
	});
	harnessDir = harnessParentDir;

	const binDir = join(sandboxDir, "bin");
	mkdirSync(binDir);
	writeFileSync(join(sandboxDir, "curl-calls.log"), "");
	writeFakeDocker(binDir);
	writeFakeCurl(binDir);
});

test.afterEach(() => {
	rmSync(sandboxDir, { recursive: true, force: true });
});

test("secret generation is idempotent and stores mode 0600", { timeout: FAKE_TEST_TIMEOUT_MS }, () => {
	const runtimeEnv = join(harnessDir, ".state", "runtime.env");

	const firstResult = runScript("generate-secrets.sh");
	assert.equal(
		firstResult.status,
		0,
		`${firstResult.stderr}\nsignal=${firstResult.signal}\nerror=${firstResult.error?.message ?? ""}`,
	);
	const first = readFileSync(runtimeEnv, "utf8");
	const secondResult = runScript("generate-secrets.sh");
	assert.equal(
		secondResult.status,
		0,
		`${secondResult.stderr}\nsignal=${secondResult.signal}\nerror=${secondResult.error?.message ?? ""}`,
	);

	assert.equal(readFileSync(runtimeEnv, "utf8"), first);
	assert.equal(statSync(runtimeEnv).mode & 0o777, 0o600);
	assert.doesNotMatch(first, /PLEX_CLAIM/);
});

test("readiness fails after the bounded final attempt", { timeout: FAKE_TEST_TIMEOUT_MS }, () => {
	const result = runScript("wait-for-services.sh", {
		CURL_SEQUENCE: "503,503,503",
		READINESS_ATTEMPTS: "3",
		READINESS_INTERVAL_SECONDS: "0",
	});

	assert.notEqual(result.status, 0);
	assert.match(result.stderr ?? "", /did not become ready/i);
});

test("bootstrap never marks completion after a failed connection test", { timeout: FAKE_TEST_TIMEOUT_MS }, () => {
	const bootstrapJson = join(harnessDir, ".state", "bootstrap.json");
	const result = runScript("bootstrap.sh", {
		CONNECTION_RESULT: "failure",
		READINESS_ATTEMPTS: "1",
		READINESS_INTERVAL_SECONDS: "0",
		PLEX_IDENTITY_ATTEMPTS: "1",
		PLEX_IDENTITY_INTERVAL_SECONDS: "0",
	});
	const curlCalls = readFileSync(join(sandboxDir, "curl-calls.log"), "utf8");

	assert.notEqual(result.status, 0);
	assert.equal(existsSync(bootstrapJson), false);
	assert.match(
		curlCalls,
		/\/api\/v1\/servers\|jar=\|cookie=.*tracearr-cookie/,
		`${result.stderr}\n${curlCalls}`,
	);
	assert.match(
		curlCalls,
		/\/api\/v1\/settings\/api-key\/regenerate\|jar=\|cookie=.*tracearr-cookie/,
		`${result.stderr}\n${curlCalls}`,
	);
});

test("bootstrap waits for Plex identity after HTTP readiness", { timeout: FAKE_TEST_TIMEOUT_MS }, () => {
	const result = runScript("bootstrap.sh", {
		CONNECTION_RESULT: "failure",
		PLEX_IDENTITY_SEQUENCE: "empty,identity",
		READINESS_ATTEMPTS: "1",
		READINESS_INTERVAL_SECONDS: "0",
		PLEX_IDENTITY_ATTEMPTS: "2",
		PLEX_IDENTITY_INTERVAL_SECONDS: "0",
	});
	const curlCalls = readFileSync(join(sandboxDir, "curl-calls.log"), "utf8");

	assert.notEqual(result.status, 0);
	assert.match(curlCalls, /\/api\/v1\/servers\|jar=\|cookie=.*tracearr-cookie/);
});

test("claimed bootstrap uses the supported Plex library query contract", { timeout: FAKE_TEST_TIMEOUT_MS }, () => {
	const bootstrapJson = join(harnessDir, ".state", "bootstrap.json");
	const result = runScript("bootstrap.sh", {
		CONNECTION_RESULT: "failure",
		PLEX_CLAIM: "claim-test",
		PLEX_TOKEN: "claimed-plex-token",
		READINESS_ATTEMPTS: "1",
		READINESS_INTERVAL_SECONDS: "0",
		PLEX_IDENTITY_ATTEMPTS: "1",
		PLEX_IDENTITY_INTERVAL_SECONDS: "0",
	});
	const curlCalls = readFileSync(join(sandboxDir, "curl-calls.log"), "utf8");

	assert.notEqual(result.status, 0);
	assert.equal(existsSync(bootstrapJson), false);
	assert.match(curlCalls, /\/library\/sections\|jar=\|cookie=/);
	assert.match(curlCalls, /\/api\/v1\/servers\|jar=\|cookie=.*tracearr-cookie/);
});
