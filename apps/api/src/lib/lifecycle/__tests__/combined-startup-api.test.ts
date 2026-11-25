import { afterEach, beforeEach, expect, it, vi } from "vitest";

// Exercise the actual API entrypoint. Native validation/runtime and socket I/O
// are substituted here; their actual integration remains a separate gate.
const state = vi.hoisted(() => ({
	events: [] as string[],
	messages: [] as unknown[],
	exits: [] as unknown[],
	diagnostics: [] as unknown[],
	stderr: [] as string[],
	environment: {} as Record<string, unknown>,
	listenerOverrides: undefined as unknown,
	mountChecks: [] as boolean[],
	listenGate: Promise.resolve(),
	initFails: false,
	listenFails: false,
	listenCode: undefined as string | undefined,
	diagnosticLogFails: false,
	throwEarlyExit: false,
	settings: { apiPort: 3011, webPort: 3010, listenAddress: "127.0.0.1" } as {
		apiPort: number | null;
		webPort: number | null;
		listenAddress: string | null;
	},
}));
function captureDiagnostic(fields: unknown) {
	if (
		typeof fields === "object" &&
		fields !== null &&
		"category" in fields &&
		fields.category === "api-startup-failure"
	) {
		state.diagnostics.push(fields);
		if (state.diagnosticLogFails) throw new Error("synthetic logging destination failure");
	}
}
vi.mock("dotenv/config", () => ({}));
vi.mock("node:fs", async (importOriginal) => {
	const actual = await importOriginal<typeof import("node:fs")>();
	return {
		...actual,
		writeSync: (...args: Parameters<typeof actual.writeSync>) => {
			if (args[0] === 2) {
				state.stderr.push(String(args[1]));
				return Buffer.byteLength(String(args[1]));
			}
			return Reflect.apply(actual.writeSync, actual, args);
		},
	};
});
vi.mock("../../backup/runtime-schema-startup.js", () => ({
	synchronizeRuntimeSchema: async (_url: string, requireMount: boolean) => {
		state.mountChecks.push(requireMount);
		state.events.push("native-validation");
		if (state.initFails) throw Error("synthetic validation failure");
		return state.settings;
	},
}));
vi.mock("../../backup/restore-runtime-admission.js", () => ({
	openRestoreRuntime: async () => {
		state.events.push("owner");
		return {
			closeAdmission() {},
			close: async () => {
				state.events.push("owner-closed");
			},
			runIndependentOperation: async (work: () => Promise<unknown>) => work(),
		};
	},
}));
vi.mock("../../backup/restore-runtime-bootstrap.js", () => ({
	loadRestoreRuntimeStartupSettings: async () => {
		state.events.push("owned-settings");
		return { apiPort: 3011, webPort: 3010, trustProxy: false, secureCookies: false };
	},
}));
vi.mock("../../logger.js", () => ({
	LOG_DIR: "synthetic",
	LOG_LEVEL: "fatal",
	logger: { error: captureDiagnostic },
}));
vi.mock("../../utils/version.js", () => ({
	getAppVersionInfo: () => ({ version: "synthetic", commitSha: "synthetic" }),
}));
vi.mock("../../../server.js", () => ({
	buildServer: ({
		env,
		combinedListenerOverrides,
	}: {
		env: Record<string, unknown>;
		combinedListenerOverrides?: unknown;
	}) => {
		state.environment = env;
		state.listenerOverrides = combinedListenerOverrides;
		return {
			config: env,
			hasDecorator: () => false,
			close: async () => {
				state.events.push("app-closed");
			},
			listen: async () => {
				state.events.push("listen");
				await state.listenGate;
				if (state.listenFails)
					throw Object.assign(Error("private bootstrap payload"), {
						code: state.listenCode,
					});
				state.events.push("listening");
			},
			log: { info() {}, error: captureDiagnostic, warn() {} },
			notificationService: { notify: async () => {} },
		};
	},
}));
const originalSend = Object.getOwnPropertyDescriptor(process, "send");
async function settle() {
	for (let i = 0; i < 10; i++) await new Promise<void>((done) => setImmediate(done));
}
async function boot() {
	await import("../../../index.js");
	await settle();
}
beforeEach(() => {
	vi.resetModules();
	state.events.length = 0;
	state.mountChecks.length = 0;
	vi.stubEnv("ARR_DOCKER_SQLITE_MOUNT_CHECK", undefined);
	state.messages.length = 0;
	state.exits.length = 0;
	state.diagnostics.length = 0;
	state.stderr.length = 0;
	state.environment = {};
	state.listenerOverrides = undefined;
	state.initFails = false;
	state.listenFails = false;
	state.listenCode = undefined;
	state.diagnosticLogFails = false;
	state.throwEarlyExit = false;
	state.listenGate = Promise.resolve();
	state.settings = { apiPort: 3011, webPort: 3010, listenAddress: "127.0.0.1" };
	for (const [key, value] of Object.entries({
		API_PORT: undefined,
		DATABASE_URL: "file:/synthetic-never-opened",
		PORT: undefined,
		HOST: undefined,
		API_HOST: "0.0.0.0",
		TRUST_PROXY: "false",
		COOKIE_SECURE: "false",
		LAUNCHER_MANAGED: "true",
		ARR_COMBINED_STARTUP_NONCE: "a".repeat(64),
		ARR_COMBINED_STARTUP_PHASE: "initial",
		ARR_COMBINED_LISTENER_OVERRIDES: undefined,
	}))
		vi.stubEnv(key, value);
	Object.defineProperty(process, "send", {
		configurable: true,
		writable: true,
		value: (message: unknown, callback: (error: Error | null) => void) => {
			state.messages.push(message);
			state.events.push("handoff");
			callback(null);
			return true;
		},
	});
	vi.spyOn(process, "on").mockReturnValue(process);
	vi.spyOn(process, "exit").mockImplementation((code) => {
		state.exits.push(code);
		if (state.throwEarlyExit && state.events.length === 0)
			throw new Error("synthetic process exit");
		return undefined as never;
	});
	vi.spyOn(console, "error").mockImplementation(() => {});
	vi.spyOn(process.stderr, "write").mockImplementation((chunk) => {
		state.stderr.push(String(chunk));
		return true;
	});
});

it.each(["junk", "65536"])(
	"refuses malformed explicit API_PORT=%s even with a saved port",
	async (raw) => {
		state.throwEarlyExit = true;
		vi.stubEnv("API_PORT", raw);
		await boot();
		expect(state.events).toEqual(["native-validation", "owner", "owned-settings", "owner-closed"]);
		expect(state.diagnostics).toEqual([
			expect.objectContaining({
				stage: "settings",
				errorCategory: "validation",
				code: "INVALID_COMBINED_API_PORT",
			}),
		]);
		expect(state.exits).toEqual([1]);
		expect(state.messages).toEqual([]);
	},
);
it.each(["combined-no-saved-port", "standalone"])(
	"refuses invalid effective API port in %s",
	async (mode) => {
		state.throwEarlyExit = true;
		vi.stubEnv("API_PORT", "junk");
		if (mode === "standalone") {
			vi.stubEnv("ARR_COMBINED_STARTUP_NONCE", undefined);
			vi.stubEnv("ARR_COMBINED_STARTUP_PHASE", undefined);
		} else state.settings.apiPort = null;
		await boot().catch(() => {});
		expect(state.exits).toEqual([1]);
		expect(state.events).not.toContain("listen");
		expect(state.messages).toEqual([]);
	},
);
it("retains unrelated environment validation before combined native I/O", async () => {
	state.throwEarlyExit = true;
	vi.stubEnv("API_PORT", "junk");
	vi.stubEnv("SESSION_TTL_HOURS", "0");
	await boot().catch(() => {});
	expect(state.exits).toEqual([1]);
	expect(state.events).toEqual([]);
});
afterEach(() => {
	vi.restoreAllMocks();
	vi.unstubAllEnvs();
	if (originalSend) Object.defineProperty(process, "send", originalSend);
	else Reflect.deleteProperty(process, "send");
});

it("sends only after validation, ownership, settings and successful listen", async () => {
	let release!: () => void;
	state.listenGate = new Promise<void>((done) => {
		release = done;
	});
	await boot();
	expect(state.events).toEqual(["native-validation", "owner", "owned-settings", "listen"]);
	expect(state.messages).toEqual([]);
	release();
	await settle();
	expect(state.events).toEqual([
		"native-validation",
		"owner",
		"owned-settings",
		"listen",
		"listening",
		"handoff",
	]);
	expect(state.messages).toEqual([
		{
			kind: "arr-combined-startup",
			version: 1,
			nonce: "a".repeat(64),
			apiPort: 3011,
			webPort: 3010,
			listenAddress: "127.0.0.1",
		},
	]);
});
it("uses saved combined listeners when the image supplies no overrides", async () => {
	await boot();
	expect(state.environment.API_PORT).toBe(3011);
	expect(state.environment.API_HOST).toBe("127.0.0.1");
	expect(state.events.filter((x) => x === "native-validation")).toHaveLength(1);
});
it.each(["initial", "restart"])("requires the Docker mount check during %s", async (phase) => {
	vi.stubEnv("ARR_DOCKER_SQLITE_MOUNT_CHECK", "1");
	vi.stubEnv("ARR_COMBINED_STARTUP_PHASE", phase);
	if (phase === "restart") {
		vi.stubEnv("ARR_COMBINED_LISTENER_OVERRIDES", "000");
		vi.stubEnv("API_PORT", "3011");
		vi.stubEnv("PORT", "3010");
		vi.stubEnv("HOST", "127.0.0.1");
	}
	await boot();
	expect(state.mountChecks).toEqual([true]);
	expect(state.events).toEqual([
		"native-validation",
		"owner",
		"owned-settings",
		"listen",
		"listening",
		"handoff",
	]);
	expect(state.exits).toEqual([]);
});
it("uses explicit combined listeners even when the values equal former image defaults", async () => {
	vi.stubEnv("API_PORT", "3001");
	vi.stubEnv("PORT", "3000");
	vi.stubEnv("HOST", "0.0.0.0");
	await boot();
	expect(state.environment).toMatchObject({ API_PORT: 3001, API_HOST: "0.0.0.0" });
	expect(state.listenerOverrides).toEqual({ apiPort: true, webPort: true, listenAddress: true });
	expect(state.messages).toEqual([
		{
			kind: "arr-combined-startup",
			version: 1,
			nonce: "a".repeat(64),
			apiPort: 3001,
			webPort: 3000,
			listenAddress: "0.0.0.0",
		},
	]);
	expect(state.events).toEqual([
		"native-validation",
		"owner",
		"owned-settings",
		"listen",
		"listening",
		"handoff",
	]);
});

it("preserves standalone environment precedence and sends no handoff", async () => {
	vi.stubEnv("API_PORT", "3001");
	vi.stubEnv("ARR_DOCKER_SQLITE_MOUNT_CHECK", "1");
	vi.stubEnv("ARR_COMBINED_STARTUP_NONCE", undefined);
	vi.stubEnv("ARR_COMBINED_STARTUP_PHASE", undefined);
	vi.stubEnv("LAUNCHER_MANAGED", "false");
	await boot();
	expect(state.environment.API_PORT).toBe(3001);
	expect(state.environment.API_HOST).toBe("0.0.0.0");
	expect(state.messages).toEqual([]);
	expect(state.mountChecks).toEqual([false]);
	expect(state.events.filter((x) => x === "native-validation")).toHaveLength(1);
});
it("revalidates a replacement child but keeps its captured per-container bindings", async () => {
	vi.stubEnv("ARR_COMBINED_STARTUP_PHASE", "restart");
	vi.stubEnv("ARR_COMBINED_LISTENER_OVERRIDES", "101");
	vi.stubEnv("API_PORT", "4011");
	vi.stubEnv("PORT", "4010");
	vi.stubEnv("HOST", "::1");
	await boot();
	expect(state.events.filter((x) => x === "native-validation")).toHaveLength(1);
	expect(state.environment.API_PORT).toBe(4011);
	expect(state.environment.API_HOST).toBe("::1");
	expect(state.listenerOverrides).toEqual({ apiPort: true, webPort: false, listenAddress: true });
	expect(state.messages).toEqual([
		{
			kind: "arr-combined-startup",
			version: 1,
			nonce: "a".repeat(64),
			apiPort: 4011,
			webPort: 4010,
			listenAddress: "::1",
		},
	]);
});
it("refuses malformed combined correlation without attempting native startup", async () => {
	vi.stubEnv("ARR_COMBINED_STARTUP_PHASE", "unknown");
	await boot();
	expect(state.events).toEqual([]);
	expect(state.exits).toEqual([1]);
	expect(state.messages).toEqual([]);
});
it("does not send or listen after failed native validation", async () => {
	state.initFails = true;
	await boot();
	expect(state.events).toEqual(["native-validation"]);
	expect(state.messages).toEqual([]);
	expect(state.exits).toEqual([1]);
});
it("does not send after listen failure and joins the existing shutdown", async () => {
	state.listenFails = true;
	await boot();
	expect(state.messages).toEqual([]);
	expect(state.events.slice(-2)).toEqual(["app-closed", "owner-closed"]);
	expect(state.exits).toEqual([1]);
});
it("reports closed startup diagnostics before server construction", async () => {
	state.initFails = true;
	await boot();
	expect(state.diagnostics).toEqual([
		{
			category: "api-startup-failure",
			stage: "schema",
			errorCategory: "unknown",
			code: null,
		},
	]);
	expect(state.stderr.join("")).toContain('"stage":"schema"');
	expect(state.stderr.join("")).not.toContain("synthetic validation failure");
	expect(state.exits).toEqual([1]);
});
it("reports a whitelisted listen diagnostic without exception details", async () => {
	state.listenFails = true;
	state.listenCode = "EACCES";
	await boot();
	expect(state.diagnostics).toEqual([
		expect.objectContaining({ category: "api-startup-failure", stage: "listen", code: "EACCES" }),
	]);
	expect(JSON.stringify([state.diagnostics, state.stderr])).not.toContain(
		"private bootstrap payload",
	);
	expect(state.events.slice(-2)).toEqual(["app-closed", "owner-closed"]);
	expect(state.exits).toEqual([1]);
});
it("preserves the failure drain when a diagnostic destination throws", async () => {
	state.listenFails = true;
	state.diagnosticLogFails = true;
	await boot();
	expect(state.stderr.join("")).toContain('"stage":"listen"');
	expect(state.events.slice(-2)).toEqual(["app-closed", "owner-closed"]);
	expect(state.exits).toEqual([1]);
});
it("identifies startup handoff rejection after listen without exposing its error", async () => {
	Object.defineProperty(process, "send", {
		configurable: true,
		value: (_message: unknown, callback: (error: Error) => void) => {
			callback(new Error("private handoff payload"));
			return true;
		},
	});
	await boot();
	expect(state.diagnostics).toEqual([
		expect.objectContaining({ category: "api-startup-failure", stage: "handoff" }),
	]);
	expect(JSON.stringify([state.diagnostics, state.stderr])).not.toContain(
		"private handoff payload",
	);
	expect(state.events.slice(-2)).toEqual(["app-closed", "owner-closed"]);
	expect(state.exits).toEqual([1]);
});
