import assert from "node:assert/strict";
import { spawn, spawnSync } from "node:child_process";
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
let fakeDaemonId;

function writeFakeDocker(binDir) {
	writeFileSync(
		join(binDir, "docker"),
		`#!/usr/bin/env bash
set -euo pipefail

if [[ "\${1:-}" == "compose" ]]; then
  printf '%s|claim=%s\n' "$*" "\${PLEX_CLAIM:+set}" >> "$DOCKER_CALL_LOG"
  if [[ " $* " == *" exec -T plex "* ]]; then
    if [[ "\${PLEX_SERVER_TOKEN_MISSING:-0}" == "1" ]]; then
      exit 0
    fi
    printf '%s' "\${PLEX_SERVER_TOKEN:-claimed-server-token}"
    exit 0
  fi
  if [[ -n "\${BOOTSTRAP_HOLD_MARKER:-}" && ! -e "$BOOTSTRAP_HOLD_MARKER" ]]; then
    printf '%s' ready > "$BOOTSTRAP_HOLD_MARKER"
    sleep "\${BOOTSTRAP_HOLD_SECONDS:-1}"
  fi
  if [[ " $* " == *" tautulli "* ]]; then
    [[ "\${TAUTULLI_FIRST_RUN_COMPLETE:-}" == "1" ]]
    [[ "\${TAUTULLI_PMS_URL_MANUAL:-}" == "1" ]]
    [[ "\${TAUTULLI_API_ENABLED:-}" == "1" ]]
    [[ "\${TAUTULLI_PMS_SSL:-}" == "0" ]]
  fi
  exit 0
fi

if [[ "\${1:-}" == "info" ]]; then
  printf '%s' "\${DOCKER_FAKE_DAEMON_ID:?}"
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
method="GET"
for ((index = 1; index <= $#; index++)); do
  argument="\${!index}"
  if [[ "$argument" == http://* || "$argument" == https://* ]]; then
    url="$argument"
  fi
  case "$argument" in
    -X|--request)
      next_index=$((index + 1))
      method="\${!next_index}"
      ;;
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

printf '%s|jar=%s|cookie=%s|method=%s\n' "$url" "$cookie_jar" "$cookie_input" "$method" >> "$CURL_CALL_LOG"

require_session() {
  if [[ -z "$cookie_input" || ! -s "$cookie_input" ]] || ! grep -q 'tracearr_session' "$cookie_input"; then
    return 1
  fi
}

write_dashboard_session() {
  if [[ -z "$cookie_jar" ]]; then
    return 1
  fi
  printf '%s\n' 'dashboard_session=owner-session' > "$cookie_jar"
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

if [[ "$url" == */api/v1/setup/status && -n "\${TRACEARR_SETUP_SEQUENCE:-}" ]]; then
  setup_state_file="\${TRACEARR_SETUP_SEQUENCE_STATE:?}"
  setup_attempt=0
  if [[ -f "$setup_state_file" ]]; then
    setup_attempt="$(cat "$setup_state_file")"
  fi
  setup_attempt=$((setup_attempt + 1))
  printf '%s' "$setup_attempt" > "$setup_state_file"
  IFS=',' read -r -a setup_statuses <<< "$TRACEARR_SETUP_SEQUENCE"
  status="\${setup_statuses[$((setup_attempt - 1))]:-\${setup_statuses[\${#setup_statuses[@]} - 1]}}"
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
    if [[ "\${TRACEARR_SETUP_COMPLETE:-0}" == "1" ]]; then
      printf '%s' '{"needsSetup":false,"requiresClaimCode":false,"hasServers":true,"hasJellyfinServers":false,"hasPasswordAuth":false,"authMethods":{"local":true,"plex":true,"oidc":false,"oidcProviderName":null}}'
    elif [[ "\${TRACEARR_ACCOUNT_EXISTS:-0}" == "1" ]]; then
      printf '%s' '{"needsSetup":true,"requiresClaimCode":false,"hasServers":false,"hasJellyfinServers":false,"hasPasswordAuth":true,"authMethods":{"local":true,"plex":true,"oidc":false,"oidcProviderName":null}}'
    else
      printf '%s' '{"needsSetup":true,"requiresClaimCode":false,"hasServers":false,"hasJellyfinServers":false,"hasPasswordAuth":false,"authMethods":{"local":true,"plex":true,"oidc":false,"oidcProviderName":null}}'
    fi
    ;;
  */api/v1/auth/sign-up/email)
    [[ "\${TRACEARR_ACCOUNT_EXISTS:-0}" != "1" ]] || exit 22
    if [[ -z "$cookie_jar" ]]; then
      exit 22
    fi
    require_json '.username == "media_analytics" and .name == "Media Analytics" and .email == "media-analytics@example.test" and (.password | type == "string" and length > 0)' || exit 22
    printf '%s\n' 'tracearr_session=owner-session' > "$cookie_jar"
    printf '%s' '{"user":{"id":"tracearr-owner"}}'
    ;;
  */api/v1/auth/sign-in/username)
    [[ "\${TRACEARR_ACCOUNT_EXISTS:-0}" == "1" || "\${TRACEARR_SETUP_COMPLETE:-0}" == "1" ]] || exit 22
    if [[ -z "$cookie_jar" ]]; then
      exit 22
    fi
    require_json '.username == "media_analytics" and .rememberMe == false and (.password | type == "string" and length > 0)' || exit 22
    printf '%s\n' 'tracearr_session=owner-session' > "$cookie_jar"
    printf '%s' '{"user":{"id":"tracearr-owner"}}'
    ;;
  */api/v1/servers)
    [[ "\${TRACEARR_SETUP_COMPLETE:-0}" != "1" ]] || exit 22
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
  */auth/setup-required)
    if [[ "\${DASHBOARD_SETUP_COMPLETE:-0}" == "1" ]]; then
      printf '%s' '{"required":false,"passwordPolicy":"strong"}'
    else
      printf '%s' '{"required":true,"passwordPolicy":"strong"}'
    fi
    ;;
  */system/agents\?mediaType=1)
    printf '%s' '<MediaContainer><Directory identifier="tv.plex.agents.movie" /></MediaContainer>'
    ;;
  */library/sections)
    if [[ "$method" == "GET" ]]; then
      if [[ "\${PLEX_LIBRARY_EXISTS:-0}" == "1" ]]; then
        printf '%s' '{"MediaContainer":{"Directory":[{"title":"Synthetic Test","Location":[{"path":"/data"}]}]}}'
      else
        printf '%s' '{"MediaContainer":{"Directory":[]}}'
      fi
    else
      require_argument 'name=Synthetic Test' "$@" || exit 22
      require_argument 'type=movie' "$@" || exit 22
      require_argument 'agent=tv.plex.agents.movie' "$@" || exit 22
      require_argument 'scanner=Plex Movie' "$@" || exit 22
      require_argument 'language=en-US' "$@" || exit 22
      require_argument 'location=/data' "$@" || exit 22
      printf '%s' '{}'
    fi
    ;;
  */auth/register)
    [[ "\${DASHBOARD_SETUP_COMPLETE:-0}" != "1" ]] || exit 22
    write_dashboard_session || exit 22
    printf '%s' '{"success":true}'
    ;;
  */auth/login)
    write_dashboard_session || exit 22
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
    if [[ "$method" == "GET" ]]; then
      if [[ "\${DASHBOARD_SERVICE_COLLISION:-0}" == "1" ]]; then
        printf '%s' '{"services":[{"id":"plex-collision","service":"plex","label":"E2E Plex","baseUrl":"http://wrong-plex:32400","hasApiKey":true}]}'
      elif [[ "\${DASHBOARD_SERVICES_EXIST:-0}" == "1" ]]; then
        printf '%s' '{"services":[{"id":"plex-existing","service":"plex","label":"E2E Plex","baseUrl":"http://plex:32400","hasApiKey":true},{"id":"tautulli-existing","service":"tautulli","label":"E2E Tautulli","baseUrl":"http://tautulli:8181","hasApiKey":true},{"id":"tracearr-existing","service":"tracearr","label":"E2E Tracearr","baseUrl":"http://tracearr:3000","hasApiKey":true}]}'
      else
        printf '%s' '{"services":[]}'
      fi
    elif [[ "\${DASHBOARD_SERVICES_EXIST:-0}" == "1" || "\${DASHBOARD_SERVICE_COLLISION:-0}" == "1" ]]; then
      exit 22
    else
      printf '%s' '{"service":{"id":"service-id"}}'
    fi
    ;;
  */api/services/*)
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
	return runScriptAt(harnessDir, scriptName, extraEnv);
}

function runScriptAt(scriptHarnessDir, scriptName, extraEnv = {}) {
	return spawnSync("bash", [join(scriptHarnessDir, "scripts", scriptName)], {
		cwd: scriptHarnessDir,
		encoding: "utf8",
		timeout: FAKE_SCRIPT_TIMEOUT_MS,
		killSignal: "SIGKILL",
		env: scriptEnvironment(extraEnv),
	});
}

function scriptEnvironment(extraEnv = {}) {
	return {
			...process.env,
			READINESS_ATTEMPTS: "1",
			READINESS_INTERVAL_SECONDS: "0",
			PLEX_IDENTITY_ATTEMPTS: "1",
			PLEX_IDENTITY_INTERVAL_SECONDS: "0",
			...extraEnv,
			CURL_CALL_LOG: join(sandboxDir, "curl-calls.log"),
			DOCKER_CALL_LOG: join(sandboxDir, "docker-calls.log"),
			DOCKER_FAKE_DAEMON_ID: fakeDaemonId,
			PLEX_IDENTITY_SEQUENCE_STATE: join(sandboxDir, "plex-identity-sequence-state"),
			TRACEARR_SETUP_SEQUENCE_STATE: join(sandboxDir, "tracearr-setup-sequence-state"),
			CURL_SEQUENCE_STATE: join(sandboxDir, "curl-sequence-state"),
			XDG_RUNTIME_DIR: join(sandboxDir, "runtime"),
			PATH: `${join(sandboxDir, "bin")}:${process.env.PATH}`,
		};
}

function runScriptAsync(scriptName, extraEnv = {}) {
	return runScriptAsyncAt(harnessDir, scriptName, extraEnv);
}

function runScriptAsyncAt(scriptHarnessDir, scriptName, extraEnv = {}) {
	const child = spawn("bash", [join(scriptHarnessDir, "scripts", scriptName)], {
		cwd: scriptHarnessDir,
		env: scriptEnvironment(extraEnv),
	});
	let stdout = "";
	let stderr = "";
	child.stdout.setEncoding("utf8").on("data", (chunk) => (stdout += chunk));
	child.stderr.setEncoding("utf8").on("data", (chunk) => (stderr += chunk));
	return new Promise((resolveResult) => {
		child.on("close", (status, signal) => resolveResult({ status, signal, stdout, stderr }));
	});
}

test.beforeEach(() => {
	sandboxDir = mkdtempSync(join(tmpdir(), "media-analytics-bootstrap-"));
	fakeDaemonId = `fake-${process.pid}-${sandboxDir.slice(-6)}`;
	const harnessParentDir = join(sandboxDir, "harness");
	mkdirSync(harnessParentDir);
	cpSync(sourceHarnessDir, harnessParentDir, {
		recursive: true,
		filter: (source) => !source.endsWith("/.state"),
	});
	harnessDir = harnessParentDir;

	const binDir = join(sandboxDir, "bin");
	mkdirSync(binDir);
	mkdirSync(join(sandboxDir, "runtime"), { mode: 0o700 });
	writeFileSync(join(sandboxDir, "curl-calls.log"), "");
	writeFileSync(join(sandboxDir, "docker-calls.log"), "");
	writeFakeDocker(binDir);
	writeFakeCurl(binDir);
});

test.afterEach(() => {
	rmSync(`/tmp/arr-dashboard-media-analytics-e2e-${process.getuid()}-${fakeDaemonId}`, {
		recursive: true,
		force: true,
	});
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
	const dashboardPassword = first.match(/^DASHBOARD_ADMIN_PASSWORD=(.+)$/m)?.[1] ?? "";
	assert.match(dashboardPassword, /[a-z]/);
	assert.match(dashboardPassword, /[A-Z]/);
	assert.match(dashboardPassword, /[0-9]/);
	assert.match(dashboardPassword, /[^A-Za-z0-9]/);
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

test("bootstrap waits for Tracearr setup readiness after shallow health passes", { timeout: FAKE_TEST_TIMEOUT_MS }, () => {
	const result = runScript("bootstrap.sh", {
		CONNECTION_RESULT: "failure",
		TRACEARR_SETUP_SEQUENCE: "503,200",
		READINESS_ATTEMPTS: "2",
		READINESS_INTERVAL_SECONDS: "0",
		PLEX_IDENTITY_ATTEMPTS: "1",
		PLEX_IDENTITY_INTERVAL_SECONDS: "0",
	});
	const curlCalls = readFileSync(join(sandboxDir, "curl-calls.log"), "utf8");
	const setupCalls = curlCalls.match(/\/api\/v1\/setup\/status/g) ?? [];

	assert.notEqual(result.status, 0);
	assert.ok(setupCalls.length >= 3, `expected setup readiness polls and setup read:\n${curlCalls}`);
	assert.match(curlCalls, /\/api\/v1\/auth\/sign-up\/email/);
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

test("bootstrap signs in when the Tracearr fixture account already exists", { timeout: FAKE_TEST_TIMEOUT_MS }, () => {
	const result = runScript("bootstrap.sh", {
		CONNECTION_RESULT: "failure",
		TRACEARR_ACCOUNT_EXISTS: "1",
		READINESS_ATTEMPTS: "1",
		READINESS_INTERVAL_SECONDS: "0",
		PLEX_IDENTITY_ATTEMPTS: "1",
		PLEX_IDENTITY_INTERVAL_SECONDS: "0",
	});
	const curlCalls = readFileSync(join(sandboxDir, "curl-calls.log"), "utf8");

	assert.notEqual(result.status, 0);
	assert.match(curlCalls, /\/api\/v1\/auth\/sign-in\/username/);
	assert.doesNotMatch(curlCalls, /\/api\/v1\/auth\/sign-up\/email/);
	assert.match(curlCalls, /\/api\/v1\/servers\|jar=\|cookie=.*tracearr-cookie/);
});

test("bootstrap signs in and reuses exact dashboard services on retry", { timeout: FAKE_TEST_TIMEOUT_MS }, () => {
	const result = runScript("bootstrap.sh", {
		DASHBOARD_SETUP_COMPLETE: "1",
		DASHBOARD_SERVICES_EXIST: "1",
		TRACEARR_SETUP_COMPLETE: "1",
		READINESS_ATTEMPTS: "1",
		READINESS_INTERVAL_SECONDS: "0",
		PLEX_IDENTITY_ATTEMPTS: "1",
		PLEX_IDENTITY_INTERVAL_SECONDS: "0",
	});
	const curlCalls = readFileSync(join(sandboxDir, "curl-calls.log"), "utf8");

	assert.equal(result.status, 0, `${result.stderr}\n${curlCalls}`);
	assert.match(curlCalls, /\/auth\/setup-required/);
	assert.match(curlCalls, /\/auth\/login/);
	assert.doesNotMatch(curlCalls, /\/auth\/register/);
	assert.match(curlCalls, /\/api\/services\|jar=\|cookie=.*dashboard-cookie\.jar\|method=GET/);
	assert.doesNotMatch(curlCalls, /\/api\/services\|jar=\|cookie=.*dashboard-cookie\|method=POST/);
	assert.match(curlCalls, /\/api\/services\/plex-existing\/test/);
	assert.match(curlCalls, /\/api\/services\/tautulli-existing\/test/);
	assert.match(curlCalls, /\/api\/services\/tracearr-existing\/test/);
});

test("bootstrap fails closed on a dashboard service identity collision", { timeout: FAKE_TEST_TIMEOUT_MS }, () => {
	const result = runScript("bootstrap.sh", {
		DASHBOARD_SETUP_COMPLETE: "1",
		DASHBOARD_SERVICE_COLLISION: "1",
		TRACEARR_SETUP_COMPLETE: "1",
		READINESS_ATTEMPTS: "1",
		READINESS_INTERVAL_SECONDS: "0",
		PLEX_IDENTITY_ATTEMPTS: "1",
		PLEX_IDENTITY_INTERVAL_SECONDS: "0",
	});
	const curlCalls = readFileSync(join(sandboxDir, "curl-calls.log"), "utf8");

	assert.notEqual(result.status, 0);
	assert.match(result.stderr ?? "", /dashboard service collision/i);
	assert.doesNotMatch(curlCalls, /\/api\/services\/plex-collision\/test/);
});

test("bootstrap resumes an already-enrolled Tracearr without adding another server", { timeout: FAKE_TEST_TIMEOUT_MS }, () => {
	const result = runScript("bootstrap.sh", {
		CONNECTION_RESULT: "failure",
		TRACEARR_SETUP_COMPLETE: "1",
		READINESS_ATTEMPTS: "1",
		READINESS_INTERVAL_SECONDS: "0",
		PLEX_IDENTITY_ATTEMPTS: "1",
		PLEX_IDENTITY_INTERVAL_SECONDS: "0",
	});
	const curlCalls = readFileSync(join(sandboxDir, "curl-calls.log"), "utf8");

	assert.notEqual(result.status, 0);
	assert.match(curlCalls, /\/api\/v1\/auth\/sign-in\/username/);
	assert.doesNotMatch(curlCalls, /\/api\/v1\/auth\/sign-up\/email/);
	assert.doesNotMatch(curlCalls, /\/api\/v1\/servers\|/);
	assert.match(curlCalls, /\/api\/v1\/settings\/api-key\/regenerate/);
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

test("claimed bootstrap reads the server-issued Plex token after claim exchange", { timeout: FAKE_TEST_TIMEOUT_MS }, () => {
	const result = runScript("bootstrap.sh", {
		CONNECTION_RESULT: "failure",
		PLEX_CLAIM: "claim-test",
		PLEX_SERVER_TOKEN: "claimed-server-token",
		READINESS_ATTEMPTS: "1",
		READINESS_INTERVAL_SECONDS: "0",
		PLEX_IDENTITY_ATTEMPTS: "1",
		PLEX_IDENTITY_INTERVAL_SECONDS: "0",
	});
	const curlCalls = readFileSync(join(sandboxDir, "curl-calls.log"), "utf8");

	assert.notEqual(result.status, 0);
	assert.doesNotMatch(result.stderr ?? "", /requires invocation-only PLEX_TOKEN/);
	assert.match(curlCalls, /\/library\/sections\|jar=\|cookie=/);
	assert.match(curlCalls, /\/api\/v1\/servers\|jar=\|cookie=.*tracearr-cookie/);
});

test("claimed bootstrap reuses an existing matching synthetic Plex library", { timeout: FAKE_TEST_TIMEOUT_MS }, () => {
	const result = runScript("bootstrap.sh", {
		CONNECTION_RESULT: "failure",
		PLEX_CLAIM: "claim-test",
		PLEX_LIBRARY_EXISTS: "1",
		READINESS_ATTEMPTS: "1",
		READINESS_INTERVAL_SECONDS: "0",
		PLEX_IDENTITY_ATTEMPTS: "1",
		PLEX_IDENTITY_INTERVAL_SECONDS: "0",
	});
	const curlCalls = readFileSync(join(sandboxDir, "curl-calls.log"), "utf8");

	assert.notEqual(result.status, 0);
	assert.match(curlCalls, /\/library\/sections\|jar=\|cookie=\|method=GET/);
	assert.doesNotMatch(curlCalls, /\/library\/sections\|jar=\|cookie=\|method=POST/);
	assert.doesNotMatch(curlCalls, /\/system\/agents\?mediaType=1/);
	assert.match(curlCalls, /\/api\/v1\/servers\|jar=\|cookie=.*tracearr-cookie/);
});

test("claimed bootstrap scrubs the one-time Plex claim after the first container start", { timeout: FAKE_TEST_TIMEOUT_MS }, () => {
	const result = runScript("bootstrap.sh", {
		CONNECTION_RESULT: "failure",
		PLEX_CLAIM: "claim-test",
		READINESS_ATTEMPTS: "1",
		READINESS_INTERVAL_SECONDS: "0",
		PLEX_IDENTITY_ATTEMPTS: "1",
		PLEX_IDENTITY_INTERVAL_SECONDS: "0",
	});
	const dockerCalls = readFileSync(join(sandboxDir, "docker-calls.log"), "utf8")
		.trim()
		.split("\n");

	assert.notEqual(result.status, 0);
	assert.match(dockerCalls[0] ?? "", /compose .* up -d plex\|claim=set/);
	assert.ok(
		dockerCalls.slice(1).every((call) => call.endsWith("|claim=")),
		`claim remained present after first Plex start:\n${dockerCalls.join("\n")}`,
	);
	assert.ok(
		dockerCalls.some((call) => /--force-recreate plex\|claim=$/.test(call)),
		`Plex was not recreated without the claim:\n${dockerCalls.join("\n")}`,
	);
});

test("claimed bootstrap scrubs the one-time claim when token exchange fails", { timeout: FAKE_TEST_TIMEOUT_MS }, () => {
	const result = runScript("bootstrap.sh", {
		PLEX_CLAIM: "claim-test",
		PLEX_SERVER_TOKEN_MISSING: "1",
		PLEX_TOKEN_ATTEMPTS: "1",
		PLEX_TOKEN_INTERVAL_SECONDS: "0",
		READINESS_ATTEMPTS: "1",
		READINESS_INTERVAL_SECONDS: "0",
		PLEX_IDENTITY_ATTEMPTS: "1",
		PLEX_IDENTITY_INTERVAL_SECONDS: "0",
	});
	const dockerCalls = readFileSync(join(sandboxDir, "docker-calls.log"), "utf8")
		.trim()
		.split("\n");

	assert.notEqual(result.status, 0);
	assert.match(result.stderr ?? "", /did not issue a server token/i);
	assert.ok(
		dockerCalls.some((call) => /--force-recreate plex\|claim=$/.test(call)),
		`failed claim was retained in Plex metadata:\n${dockerCalls.join("\n")}`,
	);
});

test("bootstrap rejects a concurrent run before provider enrollment", { timeout: FAKE_TEST_TIMEOUT_MS }, async () => {
	const marker = join(sandboxDir, "first-bootstrap-active");
	const secondHarnessDir = join(sandboxDir, "second-worktree", "media-analytics");
	mkdirSync(join(sandboxDir, "second-worktree"));
	cpSync(harnessDir, secondHarnessDir, {
		recursive: true,
		filter: (source) => !source.endsWith("/.state"),
	});
	const firstRun = runScriptAsync("bootstrap.sh", {
		BOOTSTRAP_HOLD_MARKER: marker,
		BOOTSTRAP_HOLD_SECONDS: "1",
		CONNECTION_RESULT: "failure",
		READINESS_ATTEMPTS: "1",
		READINESS_INTERVAL_SECONDS: "0",
		PLEX_IDENTITY_ATTEMPTS: "1",
		PLEX_IDENTITY_INTERVAL_SECONDS: "0",
	});

	for (let attempt = 0; attempt < 50 && !existsSync(marker); attempt += 1) {
		await new Promise((resolveWait) => setTimeout(resolveWait, 20));
	}
	assert.equal(existsSync(marker), true, "first bootstrap did not reach the held provider start");

	const secondResult = runScriptAt(secondHarnessDir, "bootstrap.sh", {
		READINESS_ATTEMPTS: "1",
		READINESS_INTERVAL_SECONDS: "0",
		PLEX_IDENTITY_ATTEMPTS: "1",
		PLEX_IDENTITY_INTERVAL_SECONDS: "0",
	});
	assert.notEqual(secondResult.status, 0);
	assert.match(secondResult.stderr ?? "", /lifecycle operation is already running/i);
	const lockDir = `/tmp/arr-dashboard-media-analytics-e2e-${process.getuid()}-${fakeDaemonId}`;
	assert.equal(statSync(lockDir).mode & 0o777, 0o700);
	assert.equal(statSync(join(lockDir, "lifecycle.lock")).mode & 0o777, 0o600);
	await firstRun;
});
