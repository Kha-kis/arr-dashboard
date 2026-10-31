import { afterEach, beforeEach, expect, it, vi } from "vitest";

// Exercise the actual API entrypoint. Native validation/runtime and socket I/O
// are substituted here; their actual integration remains a separate gate.
const state = vi.hoisted(() => ({
	events: [] as string[],
	messages: [] as unknown[],
	exits: [] as unknown[],
	environment: {} as Record<string, unknown>,
	listenGate: Promise.resolve(),
	initFails: false,
	listenFails: false,
	throwEarlyExit: false,
	settings: { apiPort: 3011, webPort: 3010, listenAddress: "127.0.0.1" } as {
		apiPort: number | null;
		webPort: number | null;
		listenAddress: string | null;
	},
}));
vi.mock("dotenv/config", () => ({}));
vi.mock("../../backup/runtime-schema-startup.js", () => ({
	synchronizeRuntimeSchema: async () => {
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
	logger: { error() {} },
}));
vi.mock("../../utils/version.js", () => ({
	getAppVersionInfo: () => ({ version: "synthetic", commitSha: "synthetic" }),
}));
vi.mock("../../../server.js", () => ({
	buildServer: ({ env }: { env: Record<string, unknown> }) => {
		state.environment = env;
		return {
			config: env,
			hasDecorator: () => false,
			close: async () => {
				state.events.push("app-closed");
			},
			listen: async () => {
				state.events.push("listen");
				await state.listenGate;
				if (state.listenFails) throw Error("synthetic listen failure");
				state.events.push("listening");
			},
			log: { info() {}, error() {}, warn() {} },
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
	state.messages.length = 0;
	state.exits.length = 0;
	state.initFails = false;
	state.listenFails = false;
	state.throwEarlyExit = false;
	state.listenGate = Promise.resolve();
	state.settings = { apiPort: 3011, webPort: 3010, listenAddress: "127.0.0.1" };
	for (const [key, value] of Object.entries({
		API_PORT: "3001",
		DATABASE_URL: "file:/synthetic-never-opened",
		PORT: "3000",
		HOST: "0.0.0.0",
		API_HOST: "0.0.0.0",
		TRUST_PROXY: "false",
		COOKIE_SECURE: "false",
		LAUNCHER_MANAGED: "true",
		ARR_COMBINED_STARTUP_NONCE: "a".repeat(64),
		ARR_COMBINED_STARTUP_PHASE: "initial",
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
});

it.each(["junk", "65536"])(
	"ignores overridden raw API_PORT=%s only when combined saved port wins",
	async (raw) => {
		state.throwEarlyExit = true;
		vi.stubEnv("API_PORT", raw);
		await boot();
		expect(state.exits).toEqual([]);
		expect(state.environment.API_PORT).toBe(3011);
		expect(state.events).toContain("handoff");
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
it("uses resolved combined database ports and address rather than image defaults", async () => {
	await boot();
	expect(state.environment.API_PORT).toBe(3011);
	expect(state.environment.API_HOST).toBe("127.0.0.1");
	expect(state.events.filter((x) => x === "native-validation")).toHaveLength(1);
});
it("preserves standalone environment precedence and sends no handoff", async () => {
	vi.stubEnv("ARR_COMBINED_STARTUP_NONCE", undefined);
	vi.stubEnv("ARR_COMBINED_STARTUP_PHASE", undefined);
	vi.stubEnv("LAUNCHER_MANAGED", "false");
	await boot();
	expect(state.environment.API_PORT).toBe(3001);
	expect(state.environment.API_HOST).toBe("0.0.0.0");
	expect(state.messages).toEqual([]);
	expect(state.events.filter((x) => x === "native-validation")).toHaveLength(1);
});
it("revalidates a replacement child but keeps its captured per-container bindings", async () => {
	vi.stubEnv("ARR_COMBINED_STARTUP_PHASE", "restart");
	vi.stubEnv("API_PORT", "4011");
	vi.stubEnv("PORT", "4010");
	vi.stubEnv("HOST", "::1");
	await boot();
	expect(state.events.filter((x) => x === "native-validation")).toHaveLength(1);
	expect(state.environment.API_PORT).toBe(4011);
	expect(state.environment.API_HOST).toBe("::1");
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
