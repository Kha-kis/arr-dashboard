import { constants, type BigIntStats } from "node:fs";
import fs from "node:fs/promises";
import path from "node:path";
import { TextDecoder } from "node:util";
import { MAX_BACKUP_UPLOAD_SIZE } from "@arr/shared";
import { generateBackupId } from "./backup-file-utils.js";

// Preserve the preparer's supported 200MiB ciphertext/plaintext ceiling.
export const MAX_STORED_RESTORE_ENVELOPE_BYTES = 4 * Math.ceil((200 * 1024 * 1024) / 3) + 65536;
const decoder = new TextDecoder("utf-8", { fatal: true });

/** Decode only canonical, bounded UTF8. Envelope parsing/authentication is separate. */
export function decodeRestoreUpload(encoded: string): string {
	let bytes: Buffer | undefined;
	try {
		if (
			typeof encoded !== "string" ||
			encoded.length === 0 ||
			encoded.length > MAX_BACKUP_UPLOAD_SIZE ||
			encoded.length % 4 !== 0 ||
			/[^A-Za-z0-9+/=]/.test(encoded)
		)
			throw new Error();
		bytes = Buffer.from(encoded, "base64");
		if (bytes.toString("base64") !== encoded) throw new Error();
		return decoder.decode(bytes);
	} catch {
		throw new Error("invalid-upload");
	} finally {
		bytes?.fill(0);
	}
}

function sameFile(before: BigIntStats, after: BigIntStats): boolean {
	return (
		before.dev === after.dev &&
		before.ino === after.ino &&
		before.size === after.size &&
		before.mtimeNs === after.mtimeNs &&
		before.ctimeNs === after.ctimeNs &&
		after.isFile()
	);
}

/** Read a freshly resolved installation-local file; never initialize storage. */
export async function readStoredRestoreEnvelope(
	directories: readonly string[],
	id: string,
): Promise<string> {
	try {
		if (!/^[a-f0-9]{24}$/.test(id) || typeof constants.O_NOFOLLOW !== "number") throw new Error();
		const matches: { filename: string; directory: string; directoryStat: BigIntStats }[] = [];
		for (const directory of directories) {
			if (!path.isAbsolute(directory)) throw new Error();
			let directoryStat: BigIntStats;
			try {
				directoryStat = await fs.lstat(directory, { bigint: true });
			} catch (error) {
				if (error && typeof error === "object" && "code" in error && error.code === "ENOENT")
					continue;
				throw error;
			}
			if (!directoryStat.isDirectory() || directoryStat.isSymbolicLink()) throw new Error();
			for (const name of await fs.readdir(directory)) {
				if (!name.endsWith(".json")) continue;
				const filename = path.join(directory, name);
				if (generateBackupId(filename) === id) matches.push({ filename, directory, directoryStat });
			}
		}
		if (matches.length !== 1) throw new Error();
		const selected = matches[0]!;
		const before = await fs.lstat(selected.filename, { bigint: true });
		if (
			!before.isFile() ||
			before.isSymbolicLink() ||
			before.size <= 0n ||
			before.size > BigInt(MAX_STORED_RESTORE_ENVELOPE_BYTES)
		)
			throw new Error();
		// NONBLOCK prevents a raced replacement with a FIFO from hanging open.
		const handle = await fs.open(
			selected.filename,
			constants.O_RDONLY | constants.O_NOFOLLOW | constants.O_NONBLOCK,
		);
		let bytes: Buffer | undefined;
		try {
			if (!sameFile(before, await handle.stat({ bigint: true }))) throw new Error();
			bytes = Buffer.allocUnsafe(Number(before.size));
			let offset = 0;
			while (offset < bytes.length) {
				const { bytesRead } = await handle.read(
					bytes,
					offset,
					Math.min(65536, bytes.length - offset),
					offset,
				);
				if (bytesRead === 0) throw new Error();
				offset += bytesRead;
			}
			const extra = Buffer.alloc(1);
			if ((await handle.read(extra, 0, 1, offset)).bytesRead !== 0) throw new Error();
			if (
				!sameFile(before, await handle.stat({ bigint: true })) ||
				!sameFile(before, await fs.lstat(selected.filename, { bigint: true }))
			)
				throw new Error();
			const directoryAfter = await fs.lstat(selected.directory, { bigint: true });
			if (
				!directoryAfter.isDirectory() ||
				directoryAfter.isSymbolicLink() ||
				directoryAfter.dev !== selected.directoryStat.dev ||
				directoryAfter.ino !== selected.directoryStat.ino
			)
				throw new Error();
			return decoder.decode(bytes);
		} finally {
			bytes?.fill(0);
			await handle.close();
		}
	} catch {
		throw new Error("stored-file-unavailable");
	}
}
