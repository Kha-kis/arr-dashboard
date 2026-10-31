import { randomBytes } from "node:crypto";
import {
	closeSync,
	constants,
	fstatSync,
	fsyncSync,
	linkSync,
	lstatSync,
	mkdtempSync,
	openSync,
	readSync,
	readdirSync,
	realpathSync,
	rmdirSync,
	unlinkSync,
	writeFileSync,
} from "node:fs";
import { isIP } from "node:net";
import { basename, join, resolve } from "node:path";

export type CombinedStartupSettings = Readonly<{
	apiPort: number;
	webPort: number;
	listenAddress: string;
}>;
export type CombinedStartupMessage = CombinedStartupSettings &
	Readonly<{ kind: "arr-combined-startup"; version: 1; nonce: string }>;
export type CombinedStartupChannel = Readonly<{
	directory: string;
	nonce: string;
	device: string;
	inode: string;
}>;
export type CombinedStartupMode = Readonly<{ nonce: string; phase: "initial" | "restart" }>;
type SettingsInput = Readonly<{
	apiPort: number | null;
	webPort: number | null;
	listenAddress: string | null;
}>;
type Environment = Readonly<Record<string, string | undefined>>;

function requireValue(condition: unknown): asserts condition {
	if (!condition) throw new Error("Combined startup handoff is unavailable.");
}
function record(value: unknown): asserts value is Record<string, unknown> {
	requireValue(value !== null && typeof value === "object" && !Array.isArray(value));
	requireValue(
		Object.getPrototypeOf(value) === Object.prototype || Object.getPrototypeOf(value) === null,
	);
}
function exactKeys(value: Record<string, unknown>, keys: string[]) {
	requireValue(JSON.stringify(Object.keys(value).sort()) === JSON.stringify([...keys].sort()));
}
function validNonce(value: unknown): asserts value is string {
	requireValue(typeof value === "string" && /^[a-f0-9]{64}$/.test(value));
}
function port(value: unknown): number {
	requireValue(
		typeof value === "number" && Number.isSafeInteger(value) && value >= 1 && value <= 65535,
	);
	return value;
}
function address(value: unknown): string {
	requireValue(typeof value === "string" && value.length > 0 && value.length <= 253);
	requireValue(
		isIP(value) !== 0 ||
			value.split(".").every((label) => /^[a-z0-9](?:[a-z0-9-]{0,61}[a-z0-9])?$/i.test(label)),
	);
	return value;
}
function environmentPort(value: string | undefined, fallback: number): number {
	if (value === undefined || value === "") return fallback;
	requireValue(/^[0-9]+$/.test(value));
	return port(Number(value));
}

/** Combined boot preserves the container's database > environment > default contract. */
export function resolveCombinedStartupSettings(
	settings: SettingsInput,
	env: Environment,
	phase: "initial" | "restart" = "initial",
): CombinedStartupSettings {
	if (phase === "restart") {
		requireValue(Boolean(env.API_PORT) && Boolean(env.PORT) && Boolean(env.HOST));
		return Object.freeze({
			apiPort: environmentPort(env.API_PORT, 3001),
			webPort: environmentPort(env.PORT, 3000),
			listenAddress: address(env.HOST),
		});
	}
	return Object.freeze({
		apiPort: port(settings.apiPort ?? environmentPort(env.API_PORT, 3001)),
		webPort: port(settings.webPort ?? environmentPort(env.PORT, 3000)),
		listenAddress: address(settings.listenAddress ?? (env.HOST || "0.0.0.0")),
	});
}

/** Coordination request only. This never authorizes skipping native startup. */
export function readCombinedStartupMode(env: Environment): CombinedStartupMode | null {
	const nonce = env.ARR_COMBINED_STARTUP_NONCE,
		phase = env.ARR_COMBINED_STARTUP_PHASE;
	if (nonce === undefined && phase === undefined) return null;
	validNonce(nonce);
	requireValue(env.LAUNCHER_MANAGED === "true" && (phase === "initial" || phase === "restart"));
	return Object.freeze({ nonce, phase });
}

/** No credentials, database identifiers, security settings or unknown fields cross IPC. */
export function parseCombinedStartupMessage(value: unknown, nonce: string): CombinedStartupMessage {
	validNonce(nonce);
	record(value);
	exactKeys(value, ["kind", "version", "nonce", "apiPort", "webPort", "listenAddress"]);
	requireValue(
		value.kind === "arr-combined-startup" && value.version === 1 && value.nonce === nonce,
	);
	return Object.freeze({
		kind: "arr-combined-startup",
		version: 1,
		nonce,
		apiPort: port(value.apiPort),
		webPort: port(value.webPort),
		listenAddress: address(value.listenAddress),
	});
}

function directoryState(directory: string) {
	requireValue(typeof directory === "string" && resolve(directory) === directory);
	requireValue(directory !== "/config" && !directory.startsWith("/config/"));
	requireValue(realpathSync(directory) === directory);
	const state = lstatSync(directory, { bigint: true });
	requireValue(
		state.isDirectory() &&
			!state.isSymbolicLink() &&
			state.uid === BigInt(process.getuid!()) &&
			(state.mode & 0o777n) === 0o700n,
	);
	return state;
}
function guardChannel(context: CombinedStartupChannel) {
	record(context);
	exactKeys(context, ["directory", "nonce", "device", "inode"]);
	validNonce(context.nonce);
	requireValue(typeof context.device === "string" && /^\d+$/.test(context.device));
	requireValue(typeof context.inode === "string" && /^\d+$/.test(context.inode));
	requireValue(/^arr-combined-startup-[A-Za-z0-9]{6}$/.test(basename(context.directory)));
	const state = directoryState(context.directory);
	requireValue(String(state.dev) === context.device && String(state.ino) === context.inode);
	return state;
}
function privateFile(path: string, pendingLink = false): Buffer | null {
	const fd = openSync(path, constants.O_RDONLY | constants.O_NOFOLLOW);
	try {
		const before = fstatSync(fd, { bigint: true });
		requireValue(
			before.isFile() &&
				before.uid === BigInt(process.getuid!()) &&
				(before.mode & 0o777n) === 0o600n,
		);
		// Publication uses an exclusive hard link then unlinks its temporary name.
		// That tiny two-link interval is not ready; it can never be accepted as data.
		if (pendingLink && before.nlink === 2n) return null;
		requireValue(before.nlink === 1n && before.size <= 4096n);
		const bytes = Buffer.alloc(4097);
		let length = 0;
		while (length < bytes.length) {
			const n = readSync(fd, bytes, length, bytes.length - length, length);
			if (n === 0) break;
			length += n;
		}
		requireValue(length <= 4096);
		const after = fstatSync(fd, { bigint: true }),
			named = lstatSync(path, { bigint: true });
		requireValue(
			after.dev === before.dev &&
				after.ino === before.ino &&
				named.dev === before.dev &&
				named.ino === before.ino &&
				!named.isSymbolicLink(),
		);
		requireValue(
			after.nlink === 1n &&
				named.nlink === 1n &&
				after.size === before.size &&
				after.size === BigInt(length) &&
				after.mtimeNs === before.mtimeNs &&
				after.ctimeNs === before.ctimeNs,
		);
		return bytes.subarray(0, length);
	} finally {
		closeSync(fd);
	}
}
function request(context: CombinedStartupChannel) {
	guardChannel(context);
	const bytes = privateFile(join(context.directory, "request.json"));
	requireValue(bytes !== null);
	const value: unknown = JSON.parse(bytes.toString("utf8"));
	record(value);
	exactKeys(value, ["version", "nonce", "startedAtNs"]);
	requireValue(value.version === 1 && value.nonce === context.nonce);
	requireValue(typeof value.startedAtNs === "string" && /^[0-9]{1,30}$/.test(value.startedAtNs));
	guardChannel(context);
	return BigInt(value.startedAtNs);
}

/** The launcher alone reads the prepared filesystem context before spawning. */
export function readCombinedStartupChannel(env: Environment): CombinedStartupChannel | null {
	const values = [
		env.ARR_COMBINED_STARTUP_DIR,
		env.ARR_COMBINED_STARTUP_NONCE,
		env.ARR_COMBINED_STARTUP_DEVICE,
		env.ARR_COMBINED_STARTUP_INODE,
	];
	if (values.every((value) => value === undefined)) return null;
	requireValue(values.every((value) => typeof value === "string"));
	const context = Object.freeze({
		directory: values[0]!,
		nonce: values[1]!,
		device: values[2]!,
		inode: values[3]!,
	});
	request(context);
	return context;
}

/** Fresh correlation data only; never a database capability or readiness result. */
export function prepareCombinedStartupChannel(root = "/tmp"): CombinedStartupChannel {
	requireValue(
		resolve(root) === root &&
			root !== "/config" &&
			!root.startsWith("/config/") &&
			realpathSync(root) === root,
	);
	const directory = mkdtempSync(join(root, "arr-combined-startup-")),
		state = directoryState(directory);
	const context = Object.freeze({
		directory,
		nonce: randomBytes(32).toString("hex"),
		device: String(state.dev),
		inode: String(state.ino),
	});
	const fd = openSync(
		join(directory, "request.json"),
		constants.O_WRONLY | constants.O_CREAT | constants.O_EXCL | constants.O_NOFOLLOW,
		0o600,
	);
	try {
		writeFileSync(
			fd,
			`${JSON.stringify({ version: 1, nonce: context.nonce, startedAtNs: process.hrtime.bigint().toString() })}\n`,
		);
		fsyncSync(fd);
	} finally {
		closeSync(fd);
	}
	request(context);
	return context;
}

/** Atomic, no-clobber result publication by the current launcher's accepted child. */
export function publishCombinedStartupResult(
	context: CombinedStartupChannel,
	input: unknown,
): void {
	request(context);
	const message = parseCombinedStartupMessage(input, context.nonce);
	const temporary = join(context.directory, `result.pending-${randomBytes(16).toString("hex")}`),
		destination = join(context.directory, "result.json");
	const fd = openSync(
			temporary,
			constants.O_WRONLY | constants.O_CREAT | constants.O_EXCL | constants.O_NOFOLLOW,
			0o600,
		),
		identity = fstatSync(fd, { bigint: true });
	try {
		try {
			writeFileSync(fd, `${JSON.stringify(message)}\n`);
			fsyncSync(fd);
		} finally {
			closeSync(fd);
		}
		request(context);
		linkSync(temporary, destination); // EEXIST, including symlinks, is a refusal.
	} finally {
		guardChannel(context);
		const state = lstatSync(temporary, { bigint: true });
		requireValue(
			state.dev === identity.dev && state.ino === identity.ino && !state.isSymbolicLink(),
		);
		unlinkSync(temporary);
	}
	const directory = openSync(
		context.directory,
		constants.O_RDONLY | constants.O_DIRECTORY | constants.O_NOFOLLOW,
	);
	try {
		fsyncSync(directory);
	} finally {
		closeSync(directory);
	}
	request(context);
}

function readResult(context: CombinedStartupChannel): CombinedStartupMessage | null {
	request(context);
	let bytes: Buffer | null;
	try {
		bytes = privateFile(join(context.directory, "result.json"), true);
	} catch (error) {
		if ((error as NodeJS.ErrnoException).code === "ENOENT") {
			guardChannel(context);
			return null;
		}
		throw error;
	}
	if (bytes === null) return null;
	const message = parseCombinedStartupMessage(JSON.parse(bytes.toString("utf8")), context.nonce);
	request(context);
	return message;
}

function revoked(context: CombinedStartupChannel): boolean {
	guardChannel(context);
	let bytes: Buffer | null;
	try {
		bytes = privateFile(join(context.directory, "revoked.json"));
	} catch (error) {
		if ((error as NodeJS.ErrnoException).code === "ENOENT") {
			guardChannel(context);
			return false;
		}
		throw error;
	}
	requireValue(bytes !== null);
	const value: unknown = JSON.parse(bytes.toString("utf8"));
	record(value);
	exactKeys(value, ["version", "nonce"]);
	requireValue(value.version === 1 && value.nonce === context.nonce);
	guardChannel(context);
	return true;
}

/** Revocation precedes retirement/termination. Missing directory means consumed. */
export function revokeCombinedStartupResult(context: CombinedStartupChannel): boolean {
	try {
		lstatSync(context.directory);
	} catch (error) {
		if ((error as NodeJS.ErrnoException).code === "ENOENT") return true;
		throw error;
	}
	// The launcher already loaded this nonce/inode-bound channel. Consumption may
	// have removed request.json; revocation must still win until rmdir succeeds.
	guardChannel(context);
	if (revoked(context)) return false;
	const fd = openSync(
		join(context.directory, "revoked.json"),
		constants.O_WRONLY | constants.O_CREAT | constants.O_EXCL | constants.O_NOFOLLOW,
		0o600,
	);
	try {
		writeFileSync(fd, `${JSON.stringify({ version: 1, nonce: context.nonce })}\n`);
		fsyncSync(fd);
	} finally {
		closeSync(fd);
	}
	requireValue(revoked(context));
	return false;
}

export function readCombinedStartupResult(
	context: CombinedStartupChannel,
): CombinedStartupMessage | null {
	const result = readResult(context);
	// No result remains pending; a positive result can never outlive revocation.
	if (result) requireValue(!revoked(context));
	return result;
}

type LauncherBinding = Readonly<{
	version: 1;
	nonce: string;
	pid: number;
	supervisorPid: number;
	startTicks: string;
}>;
function launcherIdentity(pid: number, supervisorPid: number): string {
	requireValue(
		Number.isSafeInteger(pid) &&
			pid > 1 &&
			Number.isSafeInteger(supervisorPid) &&
			supervisorPid > 0,
	);
	const fd = openSync(`/proc/${pid}/stat`, constants.O_RDONLY | constants.O_NOFOLLOW);
	let text: string;
	try {
		const bytes = Buffer.alloc(8193),
			count = readSync(fd, bytes, 0, bytes.length, 0);
		requireValue(count > 0 && count <= 8192);
		text = bytes.toString("utf8", 0, count);
	} finally {
		closeSync(fd);
	}
	const end = text.lastIndexOf(")"),
		fields = text
			.slice(end + 2)
			.trim()
			.split(/\s+/);
	requireValue(text.startsWith(`${pid} (`) && end > 0 && fields.length >= 20);
	requireValue(
		fields[0] !== "Z" &&
			fields[0] !== "X" &&
			fields[0] !== "x" &&
			Number(fields[1]) === supervisorPid,
	);
	requireValue(typeof fields[19] === "string" && /^[0-9]+$/.test(fields[19]));
	return fields[19];
}
function launcherBinding(context: CombinedStartupChannel): LauncherBinding {
	request(context);
	const bytes = privateFile(join(context.directory, "launcher.json"));
	requireValue(bytes !== null);
	const value: unknown = JSON.parse(bytes.toString("utf8"));
	record(value);
	exactKeys(value, ["version", "nonce", "pid", "supervisorPid", "startTicks"]);
	requireValue(value.version === 1 && value.nonce === context.nonce);
	requireValue(typeof value.pid === "number" && Number.isSafeInteger(value.pid) && value.pid > 1);
	requireValue(
		typeof value.supervisorPid === "number" &&
			Number.isSafeInteger(value.supervisorPid) &&
			value.supervisorPid > 0,
	);
	requireValue(typeof value.startTicks === "string" && /^[0-9]+$/.test(value.startTicks));
	return {
		version: 1,
		nonce: context.nonce,
		pid: value.pid,
		supervisorPid: value.supervisorPid,
		startTicks: value.startTicks,
	};
}

/** Bind once to the shell's tracked launcher, not merely a reusable numeric PID. */
export function bindCombinedStartupLauncher(
	context: CombinedStartupChannel,
	pid: number,
	supervisorPid: number,
): void {
	request(context);
	const startTicks = launcherIdentity(pid, supervisorPid);
	const fd = openSync(
		join(context.directory, "launcher.json"),
		constants.O_WRONLY | constants.O_CREAT | constants.O_EXCL | constants.O_NOFOLLOW,
		0o600,
	);
	try {
		writeFileSync(
			fd,
			`${JSON.stringify({ version: 1, nonce: context.nonce, pid, supervisorPid, startTicks })}\n`,
		);
		fsyncSync(fd);
	} finally {
		closeSync(fd);
	}
	request(context);
	requireValue(launcherIdentity(pid, supervisorPid) === startTicks);
}

/** One short read: null is pending, an exception is refusal, never fake readiness. */
export function readCombinedStartupStatus(
	context: CombinedStartupChannel,
): CombinedStartupMessage | null {
	const startedAt = request(context),
		now = process.hrtime.bigint();
	requireValue(now >= startedAt && now - startedAt < 600_000_000_000n);
	const binding = launcherBinding(context);
	requireValue(launcherIdentity(binding.pid, binding.supervisorPid) === binding.startTicks);
	const result = readCombinedStartupResult(context);
	requireValue(launcherIdentity(binding.pid, binding.supervisorPid) === binding.startTicks);
	return result;
}

/** Remove only this nonce/inode-bound channel's known validated metadata, never a tree. */
export function removeCombinedStartupChannel(context: CombinedStartupChannel): void {
	removeChannel(context, false);
}

/** Successful consumption rechecks readiness; cleanup after failure does not. */
export function consumeCombinedStartupChannel(context: CombinedStartupChannel): void {
	requireValue(readCombinedStartupStatus(context) !== null);
	removeChannel(context, true);
}

function removeChannel(context: CombinedStartupChannel, consume: boolean): void {
	request(context);
	const names = readdirSync(context.directory);
	requireValue(
		names.every(
			(name) =>
				name === "request.json" ||
				name === "result.json" ||
				name === "launcher.json" ||
				name === "revoked.json",
		),
	);
	if (names.includes("result.json")) requireValue(readResult(context) !== null);
	if (names.includes("launcher.json")) launcherBinding(context);
	if (names.includes("revoked.json")) requireValue(revoked(context));
	if (consume) requireValue(!revoked(context));
	const files = names.map((name) => ({
		path: join(context.directory, name),
		state: lstatSync(join(context.directory, name), { bigint: true }),
	}));
	for (const file of files) {
		guardChannel(context);
		if (consume) requireValue(!revoked(context));
		const state = lstatSync(file.path, { bigint: true });
		requireValue(
			state.dev === file.state.dev &&
				state.ino === file.state.ino &&
				!state.isSymbolicLink() &&
				state.nlink === 1n &&
				state.uid === BigInt(process.getuid!()),
		);
		unlinkSync(file.path);
	}
	guardChannel(context);
	rmdirSync(context.directory);
}
