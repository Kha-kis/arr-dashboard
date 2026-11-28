import {
	lstatSync,
	readdirSync,
	readFileSync,
	readlinkSync,
	realpathSync,
	statfsSync,
	statSync,
} from "node:fs";
import { dirname, posix, resolve } from "node:path";
import { RuntimeSchemaStartupError } from "./runtime-schema-startup.js";

const ELIGIBLE_FILESYSTEMS = new Set([
	0xef53n,
	0x58465342n,
	0x9123683en,
	0x01021994n,
	0x794c7630n,
	0x2fc12fc1n, // Local Linux ZFS; native ownership and operation locks remain separate gates.
]);

const PERSISTENT_DOCKER_FILESYSTEMS = new Map([
	["ext4", 0xef53n],
	["xfs", 0x58465342n],
	["btrfs", 0x9123683en],
	["zfs", 0x2fc12fc1n],
]);

export class SqliteDockerMountRequiredError extends RuntimeSchemaStartupError {
	constructor() {
		super("sqlite-mount-required");
		this.name = "SqliteDockerMountRequiredError";
	}
}

export class SqliteRestoreStorageUnavailableError extends Error {
	readonly statusCode = 503;
	constructor() {
		super("SQLite Restore storage is unavailable");
		this.name = "SqliteRestoreStorageUnavailableError";
	}
}

export type SqliteRestoreStorage = Readonly<{
	databasePath: string;
	directoryPath: string;
	coordinationDirectoryPath: string;
	assertUnchanged(): void;
}>;

type EligibleMountInput = Readonly<{
	databasePath: string;
	mountInfo: string;
	filesystemType: bigint;
	platform: string;
}>;

// One successful, bounded pure computation only. Callers still acquire fresh
// mount/statfs evidence and independently recheck inode and ownership every time.
let lastEligibleMountInput: EligibleMountInput | undefined;

export function isEligibleSqliteRestoreMount(
	databasePath: string,
	mountInfo: string,
	filesystemType: bigint,
	platform: string,
): boolean {
	if (
		lastEligibleMountInput?.databasePath === databasePath &&
		lastEligibleMountInput.mountInfo === mountInfo &&
		lastEligibleMountInput.filesystemType === filesystemType &&
		lastEligibleMountInput.platform === platform
	)
		return true;
	if (!classifySqliteRestoreMount(databasePath, mountInfo, filesystemType, platform)) return false;
	lastEligibleMountInput = { databasePath, mountInfo, filesystemType, platform };
	return true;
}

/** A separate mount boundary is not proof of operator retention or storage continuity. */
export function hasSeparateDockerSqliteMount(
	databasePath: string,
	mountInfo: string,
	filesystemType: bigint,
	platform: string,
): boolean {
	return classifySqliteRestoreMount(databasePath, mountInfo, filesystemType, platform, true);
}

export function assertDockerSqliteMount(databasePath: string): void {
	try {
		if (
			hasSeparateDockerSqliteMount(
				databasePath,
				readFileSync("/proc/self/mountinfo", "utf8"),
				statfsSync(dirname(databasePath), { bigint: true }).type,
				process.platform,
			)
		)
			return;
	} catch {
		// Use the same fixed guidance if the mount cannot be verified.
	}
	throw new SqliteDockerMountRequiredError();
}

function classifySqliteRestoreMount(
	databasePath: string,
	mountInfo: string,
	filesystemType: bigint,
	platform: string,
	requireSeparate = false,
): boolean {
	if (
		platform !== "linux" ||
		!ELIGIBLE_FILESYSTEMS.has(filesystemType) ||
		!posix.isAbsolute(databasePath) ||
		posix.resolve(databasePath) !== databasePath ||
		mountInfo.length === 0 ||
		mountInfo.length > 1024 * 1024
	) {
		return false;
	}
	const lines = mountInfo.replace(/\n$/, "").split("\n");
	if (lines.length > 10000) return false;
	const seenIds = new Set<string>();
	let hasContainingMount = false;
	const containingPaths = new Set<string>();
	let closestMount: { path: string; writableLocal: boolean } | undefined;
	for (const line of lines) {
		const halves = line.split(" - ");
		if (halves.length !== 2) return false;
		const fields = halves[0]!.split(" ");
		const tail = halves[1]!.split(" ");
		if (
			fields.length < 6 ||
			tail.length !== 3 ||
			[...fields, ...tail].some((field) => !field || containsControl(field)) ||
			!/^[1-9]\d*$/.test(fields[0]!) ||
			!/^\d+$/.test(fields[1]!) ||
			!/^\d+:\d+$/.test(fields[2]!) ||
			seenIds.has(fields[0]!)
		) {
			return false;
		}
		seenIds.add(fields[0]!);
		const root = decodeMountPath(fields[3]!);
		const mountPath = decodeMountPath(fields[4]!);
		if (!root || !mountPath?.startsWith("/") || mountPath === databasePath) {
			return false;
		}
		if (databasePath.startsWith(mountPath === "/" ? "/" : `${mountPath}/`)) {
			if (!root.startsWith("/")) return false;
			hasContainingMount = true;
			if (requireSeparate) {
				// A stacked ancestor can hide a deeper mount. Refuse ambiguous topology.
				if (containingPaths.has(mountPath)) return false;
				containingPaths.add(mountPath);
				if (!closestMount || closestMount.path.length < mountPath.length) {
					closestMount = {
						path: mountPath,
						writableLocal:
							mountPath !== "/" &&
							fields[5]!.split(",").includes("rw") &&
							tail[2]!.split(",").includes("rw") &&
							PERSISTENT_DOCKER_FILESYSTEMS.get(tail[0]!) === filesystemType,
					};
				}
			}
		}
	}
	return requireSeparate ? closestMount?.writableLocal === true : hasContainingMount;
}

function decodeMountPath(value: string): string | undefined {
	if (/\\(?!040|011|012|134)/.test(value)) return undefined;
	return value.replace(/\\(040|011|012|134)/g, (_match, octal: string) =>
		String.fromCharCode(Number.parseInt(octal, 8)),
	);
}

function containsControl(value: string): boolean {
	for (const character of value) {
		const code = character.charCodeAt(0);
		if (code < 0x20 || code === 0x7f) return true;
	}
	return false;
}

type StorageIdentity = {
	databasePath: string;
	directoryPath: string;
	device: bigint;
	inode: bigint;
	directoryDevice: bigint;
	directoryInode: bigint;
};

function sameIdentity(left: StorageIdentity, right: StorageIdentity): boolean {
	return (
		left.databasePath === right.databasePath &&
		left.directoryPath === right.directoryPath &&
		left.device === right.device &&
		left.inode === right.inode &&
		left.directoryDevice === right.directoryDevice &&
		left.directoryInode === right.directoryInode
	);
}

function inspectIdentity(aliasPath: string): StorageIdentity {
	const databasePath = realpathSync(aliasPath);
	// Every eventual adapter must open this canonical filename faithfully. A
	// symlink can resolve to a name the driver's trim would change on reopen.
	if (databasePath.trim() !== databasePath || containsControl(databasePath)) {
		throw new SqliteRestoreStorageUnavailableError();
	}
	const directoryPath = dirname(databasePath);
	// Metadata only: opening/closing an active database outside SQLite can
	// invalidate another thread's POSIX locks. Never read/hash these files.
	const file = lstatSync(databasePath, { bigint: true });
	const directory = lstatSync(directoryPath, { bigint: true });
	if (
		!file.isFile() ||
		file.nlink !== 1n ||
		!directory.isDirectory() ||
		file.dev !== directory.dev
	) {
		throw new SqliteRestoreStorageUnavailableError();
	}
	return {
		databasePath,
		directoryPath,
		device: file.dev,
		inode: file.ino,
		directoryDevice: directory.dev,
		directoryInode: directory.ino,
	};
}

function inspectEligibleIdentity(aliasPath: string): StorageIdentity {
	const identity = inspectIdentity(aliasPath);
	if (
		!isEligibleSqliteRestoreMount(
			identity.databasePath,
			readFileSync("/proc/self/mountinfo", "utf8"),
			statfsSync(identity.directoryPath, { bigint: true }).type,
			process.platform,
		) ||
		!sameIdentity(identity, inspectIdentity(aliasPath))
	) {
		throw new SqliteRestoreStorageUnavailableError();
	}
	return identity;
}

/** Storage eligibility only; this handle is not a lock or a Restore capability. */
export function resolveSqliteRestoreStorage(databaseUrl: string): SqliteRestoreStorage {
	try {
		if (typeof databaseUrl !== "string" || containsControl(databaseUrl)) {
			throw new SqliteRestoreStorageUnavailableError();
		}
		const path = databaseUrl.replace(/^file:/, "").trim();
		if (!path || path === ":memory:" || /^(file:|postgres(?:ql)?:\/\/)/i.test(path)) {
			throw new SqliteRestoreStorageUnavailableError();
		}
		const aliasPath = resolve(path);
		const identity = inspectEligibleIdentity(aliasPath);
		let unavailable = false;
		return Object.freeze({
			databasePath: identity.databasePath,
			directoryPath: identity.directoryPath,
			coordinationDirectoryPath: `${identity.databasePath}.arr-restore-runtime`,
			assertUnchanged(): void {
				try {
					if (unavailable || !sameIdentity(identity, inspectEligibleIdentity(aliasPath))) {
						throw new SqliteRestoreStorageUnavailableError();
					}
				} catch {
					unavailable = true;
					throw new SqliteRestoreStorageUnavailableError();
				}
			},
		});
	} catch {
		throw new SqliteRestoreStorageUnavailableError();
	}
}

/** Validate the SQLite-owned descriptor through metadata only. */
export function sqliteOpenedDescriptors(path: string): readonly string[] {
	const expected = lstatSync(path, { bigint: true });
	const matches: string[] = [];
	for (const name of readdirSync("/proc/self/fd")) {
		if (!/^\d+$/.test(name)) continue;
		const descriptor = `/proc/self/fd/${name}`;
		try {
			const target = readlinkSync(descriptor);
			if (target !== path && target !== `${path} (deleted)`) continue;
			const actual = statSync(descriptor, { bigint: true });
			if (!actual.isFile() || actual.dev !== expected.dev || actual.ino !== expected.ino)
				throw new RuntimeSchemaStartupError();
			matches.push(name);
		} catch (error) {
			if (error && typeof error === "object" && "code" in error && error.code === "ENOENT")
				continue;
			throw error;
		}
	}
	return matches;
}

export function assertSqliteOpenedDescriptor(path: string): void {
	if (sqliteOpenedDescriptors(path).length !== 1) throw new RuntimeSchemaStartupError();
}
