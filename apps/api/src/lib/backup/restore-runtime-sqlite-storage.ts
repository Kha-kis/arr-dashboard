import { lstatSync, readFileSync, realpathSync, statfsSync } from "node:fs";
import { dirname, posix, resolve } from "node:path";

const ELIGIBLE_FILESYSTEMS = new Set([
	0xef53n,
	0x58465342n,
	0x9123683en,
	0x01021994n,
	0x794c7630n,
	0x2fc12fc1n, // Local Linux ZFS; native ownership and operation locks remain separate gates.
]);

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

export function isEligibleSqliteRestoreMount(
	databasePath: string,
	mountInfo: string,
	filesystemType: bigint,
	platform: string,
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
		}
	}
	return hasContainingMount;
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
