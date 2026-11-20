import { createHash } from "node:crypto";
import fs from "node:fs/promises";
import os from "node:os";
import path from "node:path";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";

async function input() {
	const module = await import("../backup-restore-input.js").catch(() => undefined);
	expect(module, "bounded Restore input implementation must exist").toBeDefined();
	return module!;
}
const idFor = (filename: string) =>
	createHash("sha256").update(filename).digest("hex").slice(0, 24);
const encryptedText = '{"version":"1.0","synthetic":"encrypted-envelope"}';

describe("bounded canonical Restore upload intake", () => {
	it("decodes the encrypted envelope exactly without parsing or changing it", async () => {
		const { decodeRestoreUpload } = await input();
		expect(decodeRestoreUpload(Buffer.from(encryptedText).toString("base64"))).toBe(encryptedText);
	});
	it.each(["", "e30", "e30= ", "e30=\n", "e30===", "Zh==", "-w==", "/w=="])(
		"refuses malformed, noncanonical or non-UTF8 upload %j generically",
		async (encoded) => {
			const { decodeRestoreUpload } = await input();
			expect(() => decodeRestoreUpload(encoded)).toThrow(/^invalid-upload$/);
		},
	);
	it("refuses encoded overflow before decoding it", async () => {
		const { decodeRestoreUpload } = await input();
		expect(() => decodeRestoreUpload("a".repeat(50 * 1024 * 1024 + 1))).toThrow(/^invalid-upload$/);
	});
});

describe("fresh identity-checked stored Restore intake", () => {
	let root: string;
	let directory: string;
	let filename: string;
	beforeEach(async () => {
		root = await fs.mkdtemp(path.join(os.tmpdir(), "restore-input-owned-"));
		directory = path.join(root, "manual");
		await fs.mkdir(directory, { mode: 0o700 });
		filename = path.join(directory, "synthetic-backup.json");
		await fs.writeFile(filename, encryptedText, { mode: 0o600 });
	});
	afterEach(async () => {
		vi.restoreAllMocks();
		if (root) await fs.rm(root, { recursive: true, force: true });
	});
	it("reads the freshly resolved regular file without modifying it", async () => {
		const { readStoredRestoreEnvelope } = await input();
		const before = await fs.stat(filename, { bigint: true });
		expect(await readStoredRestoreEnvelope([directory], idFor(filename))).toBe(encryptedText);
		const after = await fs.stat(filename, { bigint: true });
		expect([after.ino, after.dev, after.size, after.mtimeNs, after.ctimeNs]).toEqual([
			before.ino,
			before.dev,
			before.size,
			before.mtimeNs,
			before.ctimeNs,
		]);
	});
	it("does not initialize a missing backup directory", async () => {
		const { readStoredRestoreEnvelope } = await input();
		const missing = path.join(root, "scheduled");
		expect(await readStoredRestoreEnvelope([missing, directory], idFor(filename))).toBe(
			encryptedText,
		);
		await expect(fs.stat(missing)).rejects.toMatchObject({ code: "ENOENT" });
	});
	it.each(["", "../synthetic-backup.json", "a".repeat(23), "A".repeat(24), "a".repeat(24)])(
		"rejects malformed or absent stored ID %j without private error details",
		async (id) => {
			const { readStoredRestoreEnvelope } = await input();
			await expect(readStoredRestoreEnvelope([directory], id)).rejects.toThrow(
				/^stored-file-unavailable$/,
			);
		},
	);
	it("refuses a selected symlink rather than reading its target", async () => {
		const { readStoredRestoreEnvelope } = await input();
		const alias = path.join(directory, "alias.json");
		await fs.symlink(filename, alias);
		await expect(readStoredRestoreEnvelope([directory], idFor(alias))).rejects.toThrow(
			/^stored-file-unavailable$/,
		);
	});
	it("refuses an aliased backup directory", async () => {
		const { readStoredRestoreEnvelope } = await input();
		const alias = path.join(root, "aliased");
		await fs.symlink(directory, alias);
		await expect(
			readStoredRestoreEnvelope([alias], idFor(path.join(alias, "synthetic-backup.json"))),
		).rejects.toThrow(/^stored-file-unavailable$/);
	});
	it("refuses a directory masquerading as the selected backup", async () => {
		const { readStoredRestoreEnvelope } = await input();
		const fake = path.join(directory, "directory.json");
		await fs.mkdir(fake);
		await expect(readStoredRestoreEnvelope([directory], idFor(fake))).rejects.toThrow(
			/^stored-file-unavailable$/,
		);
	});
	it("refuses ambiguous resolution rather than picking the first match", async () => {
		const { readStoredRestoreEnvelope } = await input();
		await expect(
			readStoredRestoreEnvelope([directory, directory], idFor(filename)),
		).rejects.toThrow(/^stored-file-unavailable$/);
	});
	it("refuses a file replaced after the actual no-follow open", async () => {
		const { readStoredRestoreEnvelope } = await input();
		const open = fs.open.bind(fs);
		vi.spyOn(fs, "open").mockImplementation(async (...args) => {
			const handle = await open(...args);
			if (args[0] === filename) {
				await fs.rename(filename, path.join(directory, "retained-original.json"));
				await fs.writeFile(filename, '{"different":"synthetic"}', { mode: 0o600 });
			}
			return handle;
		});
		await expect(readStoredRestoreEnvelope([directory], idFor(filename))).rejects.toThrow(
			/^stored-file-unavailable$/,
		);
	});
	it("refuses unsupported size using sparse-file metadata before allocating input", async () => {
		const { readStoredRestoreEnvelope } = await input();
		const handle = await fs.open(filename, "r+");
		try {
			await handle.truncate(4 * Math.ceil((200 * 1024 * 1024) / 3) + 65536 + 1);
		} finally {
			await handle.close();
		}
		await expect(readStoredRestoreEnvelope([directory], idFor(filename))).rejects.toThrow(
			/^stored-file-unavailable$/,
		);
	});
	it("refuses invalid UTF8 rather than silently replacing bytes", async () => {
		const { readStoredRestoreEnvelope } = await input();
		await fs.writeFile(filename, Buffer.from([255, 254]));
		await expect(readStoredRestoreEnvelope([directory], idFor(filename))).rejects.toThrow(
			/^stored-file-unavailable$/,
		);
	});
	// The owned QA runner is the same unprivileged Linux UID as normal local tests.
	it.skipIf(process.getuid?.() === 0)("refuses an unreadable file generically", async () => {
		const { readStoredRestoreEnvelope } = await input();
		await fs.chmod(filename, 0o000);
		await expect(readStoredRestoreEnvelope([directory], idFor(filename))).rejects.toThrow(
			/^stored-file-unavailable$/,
		);
	});
	it("refuses in-place mutation after open even if inode and length stay the same", async () => {
		const { readStoredRestoreEnvelope } = await input();
		const open = fs.open.bind(fs);
		vi.spyOn(fs, "open").mockImplementation(async (...args) => {
			const handle = await open(...args);
			if (args[0] === filename) {
				const changed = encryptedText.replace("encrypted-envelope", "different-envelope");
				expect(Buffer.byteLength(changed)).toBe(Buffer.byteLength(encryptedText));
				await fs.writeFile(filename, changed);
			}
			return handle;
		});
		await expect(readStoredRestoreEnvelope([directory], idFor(filename))).rejects.toThrow(
			/^stored-file-unavailable$/,
		);
	});
});
