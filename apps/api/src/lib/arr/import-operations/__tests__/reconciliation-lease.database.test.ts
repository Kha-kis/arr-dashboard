import { execFileSync } from "node:child_process";
import { createHash } from "node:crypto";
import { mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterAll, beforeAll, beforeEach, describe, expect, it } from "vitest";
import { createTestPrismaClient } from "../../../__tests__/test-prisma.js";
import {
	acquireImportReconcileLease,
	finishImportReconcileLease,
	type ImportReconcileCursor,
	parseImportReconcileCursor,
} from "../reconciliation-lease.js";

const now = new Date("2036-10-01T12:00:00.000Z");
const ownerId = "lease-owner";
const otherOwnerId = "other-owner";
const operationId = "lease-operation";
const commandFingerprint = versionedHash("command");
const sourceA = hash("source-a");
const sourceB = hash("source-b");
const fileA = versionedHash("a");
const fileB = versionedHash("b");
const commandEndedAt = new Date(now.getTime() - 1_000).toISOString();
const tempDirs: string[] = [];
let prisma: ReturnType<typeof createTestPrismaClient>;
let peer: ReturnType<typeof createTestPrismaClient>;

function hash(value: string): string {
	return createHash("sha256").update(value).digest("hex");
}

function versionedHash(value: string): string {
	return `v1:${hash(value)}`;
}

function file(seed: string, downloadKey: string, episodeIds: number[]) {
	return {
		fileFingerprint: versionedHash(seed),
		downloadKey,
		identityJson: {
			pathHash: hash(`path:${seed}`),
			seriesId: 100,
			episodeIds,
			episodeFileId: 500 + episodeIds[0]!,
		},
	};
}

async function seedOperation(
	options: {
		state?: string;
		submitted?: boolean;
		nextCheckAt?: Date | null;
		reconcileToken?: string | null;
		reconcileExpiresAt?: Date | null;
		reconcileCursor?: object | null;
		commandId?: number | null;
		service?: "SONARR" | "RADARR";
		submissionStartedAt?: Date | null;
		files?: ReturnType<typeof file>[];
		owner?: string;
		id?: string;
	} = {},
) {
	const owner = options.owner ?? ownerId;
	const id = options.id ?? operationId;
	await prisma.user.create({ data: { id: owner, username: `synthetic-${owner}` } });
	const cursor = options.reconcileCursor;
	return prisma.arrImportOperation.create({
		data: {
			id,
			userId: owner,
			originalInstanceId: "historical-instance",
			connectionFingerprint: hash("connection"),
			service: options.service ?? "SONARR",
			origin: "manual",
			mode: "Move",
			idempotencyKey: `key-${id}`,
			requestFingerprint: versionedHash("request"),
			commandFingerprint,
			encryptedSources: "synthetic-ciphertext",
			sourcesEncryptionIv: "synthetic-iv",
			state: options.state ?? "pending",
			commandId: options.commandId === undefined ? 42 : options.commandId,
			commandState: "pending",
			commandTerminal: false,
			selectedFileCount: (
				options.files ?? [file("a", sourceA, [1001, 1002]), file("b", sourceB, [2001])]
			).length,
			preparationExpiresAt: new Date(now.getTime() + 60_000),
			submissionStartedAt:
				options.submissionStartedAt ??
				(options.submitted === false ? null : new Date(now.getTime() - 30_000)),
			nextCheckAt: options.nextCheckAt === undefined ? null : options.nextCheckAt,
			reconcileToken: options.reconcileToken ?? null,
			reconcileExpiresAt: options.reconcileExpiresAt ?? null,
			reconcileCursor: cursor ?? undefined,
			files: {
				create: options.files ?? [file("a", sourceA, [1001, 1002]), file("b", sourceB, [2001])],
			},
		},
		include: { files: true },
	});
}

async function snapshot(id = operationId, owner = ownerId) {
	return prisma.arrImportOperation.findFirstOrThrow({
		where: { id, userId: owner },
		include: { files: { orderBy: { fileFingerprint: "asc" } } },
	});
}

function validCursor(
	overrides: Partial<Extract<ImportReconcileCursor, { version: 1 }>> = {},
): Extract<ImportReconcileCursor, { version: 1 }> {
	return {
		version: 1,
		commandFingerprint,
		commandId: 42,
		commandEndedAt,
		sourceIndex: 0,
		page: 1,
		pageSize: null,
		totalRecords: null,
		seenRecords: 0,
		witnesses: [],
		ambiguousFiles: [],
		...overrides,
	};
}

async function acquire(client = prisma, owner = ownerId, id = operationId, checkedAt = now) {
	return acquireImportReconcileLease(client, owner, id, checkedAt);
}

async function finish(
	lease: NonNullable<Awaited<ReturnType<typeof acquire>>>,
	input: {
		cursor: ImportReconcileCursor | null;
		reason:
			| "evidence-unavailable"
			| "coverage-incomplete"
			| "budget-yield"
			| "connection-changed"
			| null;
	} = { cursor: null, reason: "evidence-unavailable" },
) {
	return finishImportReconcileLease(
		prisma,
		ownerId,
		operationId,
		lease.token,
		lease.operation.revision,
		now,
		{ ...input, nextCheckAt: new Date(now.getTime() + 5_000) },
	);
}

beforeAll(() => {
	const directory = mkdtempSync(join(tmpdir(), "arr-import-reconcile-lease-"));
	tempDirs.push(directory);
	const dbPath = join(directory, "fixture.db");
	execFileSync("pnpm", ["exec", "prisma", "db", "push", "--schema", "prisma/schema.prisma"], {
		cwd: process.cwd(),
		env: { ...process.env, DATABASE_URL: `file:${dbPath}` },
		stdio: "ignore",
	});
	prisma = createTestPrismaClient(`file:${dbPath}`);
	peer = createTestPrismaClient(`file:${dbPath}`);
}, 30_000);

beforeEach(async () => {
	await prisma.arrImportFileProof.deleteMany();
	await prisma.arrImportOperation.deleteMany();
	await prisma.serviceInstance.deleteMany();
	await prisma.user.deleteMany();
});

afterAll(async () => {
	await peer?.$disconnect();
	await prisma?.$disconnect();
	for (const directory of tempDirs.splice(0)) rmSync(directory, { recursive: true, force: true });
});

describe("durable import reconciliation leases", { timeout: 30_000 }, () => {
	it("validates retained covered facts across sources while preserving the old cursor contract", async () => {
		const operation = await seedOperation();
		const old = validCursor({ sourceIndex: 2 });
		expect(parseImportReconcileCursor(operation, old, now)).toEqual(old);
		const retained = {
			...old,
			version: 2,
			retainedWitnesses: [{ fileFingerprint: fileA, fileId: 31, episodeIds: [1001] }],
			retainedAmbiguousFiles: [fileB],
		};
		expect(parseImportReconcileCursor(operation, retained, now)).toEqual(retained);
	});
	it.each(["foreign", "episode", "empty-episode", "duplicate", "overlap", "private-field"])(
		"rejects %s retained covered facts",
		async (kind) => {
			const operation = await seedOperation();
			const witness = { fileFingerprint: fileA, fileId: 31, episodeIds: [1001] };
			const retained = {
				...validCursor({ sourceIndex: 2 }),
				version: 2,
				retainedWitnesses: [witness],
				retainedAmbiguousFiles: [] as string[],
			};
			if (kind === "foreign")
				retained.retainedWitnesses = [{ ...witness, fileFingerprint: versionedHash("foreign") }];
			if (kind === "episode") retained.retainedWitnesses = [{ ...witness, episodeIds: [9999] }];
			if (kind === "empty-episode") retained.retainedWitnesses = [{ ...witness, episodeIds: [] }];
			if (kind === "duplicate") retained.retainedWitnesses.push(witness);
			if (kind === "overlap") retained.retainedAmbiguousFiles.push(fileA);
			expect(
				parseImportReconcileCursor(
					operation,
					kind === "private-field" ? { ...retained, path: "/private" } : retained,
					now,
				),
			).toBeNull();
		},
	);
	it("does not erase invalid historical cursor data on an unavailable read", async () => {
		const cursor = { version: 99, generic: "unknown-evidence" };
		await seedOperation({ reconcileCursor: cursor });
		const lease = await acquire();
		expect(lease).not.toBeNull();
		expect(await finish(lease!, { cursor: null, reason: "evidence-unavailable" })).toBe(true);
		expect(await snapshot()).toMatchObject({ reconcileCursor: cursor, reconcileToken: null });
	});
	it("bounds distinct episode coordinates across retained and provisional evidence together", async () => {
		const priorIds = Array.from({ length: 6000 }, (_, index) => index + 1);
		const nextIds = Array.from({ length: 4001 }, (_, index) => index + 1);
		const operation = await seedOperation({
			files: [file("a", sourceA, priorIds), file("b", sourceB, nextIds)],
		});
		const cursor = {
			...validCursor({ sourceIndex: [sourceA, sourceB].sort().indexOf(sourceB) }),
			version: 2,
			witnesses: [{ fileFingerprint: fileB, fileId: 32, episodeIds: nextIds }],
			retainedWitnesses: [{ fileFingerprint: fileA, fileId: 31, episodeIds: priorIds }],
			retainedAmbiguousFiles: [],
		};
		expect(parseImportReconcileCursor(operation, cursor, now) === null).toBe(true);
		expect(
			parseImportReconcileCursor(
				operation,
				{ ...cursor, witnesses: [{ ...cursor.witnesses[0]!, episodeIds: nextIds.slice(0, 4000) }] },
				now,
			),
		).not.toBeNull();
	});
	it("does not replace unknown historical evidence with a fresh empty cursor", async () => {
		const cursor = { version: 99, generic: "unknown-evidence" };
		await seedOperation({ reconcileCursor: cursor });
		const lease = await acquire();
		expect(await finish(lease!, { cursor: validCursor(), reason: "budget-yield" })).toBe(false);
		expect((await snapshot()).reconcileCursor).toEqual(cursor);
	});
	it.each(["downgrade", "drop", "change-file", "drop-ambiguity"])(
		"refuses to %s retained covered evidence at the lease fence",
		async (kind) => {
			const cursor = {
				...validCursor({ sourceIndex: 2 }),
				version: 2,
				retainedWitnesses: [{ fileFingerprint: fileA, fileId: 31, episodeIds: [1001] }],
				retainedAmbiguousFiles: [fileB],
			};
			await seedOperation({ reconcileCursor: cursor });
			const lease = await acquire();
			const next =
				kind === "downgrade"
					? validCursor()
					: {
							...cursor,
							retainedWitnesses:
								kind === "drop"
									? []
									: [
											{
												fileFingerprint: fileA,
												fileId: kind === "change-file" ? 32 : 31,
												episodeIds: [1001],
											},
										],
							retainedAmbiguousFiles: kind === "drop-ambiguity" ? [] : [fileB],
						};
			expect(
				await finishImportReconcileLease(
					prisma,
					ownerId,
					operationId,
					lease!.token,
					lease!.operation.revision,
					now,
					{
						cursor: next as ImportReconcileCursor,
						reason: "budget-yield",
						nextCheckAt: new Date(now.getTime() + 5000),
					},
				),
			).toBe(false);
			expect((await snapshot()).reconcileCursor).toEqual(cursor);
		},
	);
	it("admits one due submitted operation and refuses the competing independent client", async () => {
		await seedOperation();
		const [first, second] = await Promise.all([acquire(prisma), acquire(peer)]);
		expect([first, second].filter(Boolean)).toHaveLength(1);
		const winner = first ?? second;
		expect(winner?.token).toMatch(/^[0-9a-f-]{36}$/);
		expect(winner?.expiresAt.getTime()).toBe(now.getTime() + 30_000);
		const stored = await snapshot();
		expect(stored.reconcileToken).toBe(winner?.token);
		expect(stored.revision).toBe(1);
	});

	it("refuses a live token, a future due time, and operations without a submitted command", async () => {
		await seedOperation({
			reconcileToken: "live-token",
			reconcileExpiresAt: new Date(now.getTime() + 5_000),
		});
		expect(await acquire()).toBeNull();
		await prisma.arrImportOperation.update({
			where: { id: operationId },
			data: {
				reconcileToken: null,
				reconcileExpiresAt: null,
				nextCheckAt: new Date(now.getTime() + 1),
			},
		});
		expect(await acquire()).toBeNull();
		await prisma.arrImportOperation.update({
			where: { id: operationId },
			data: { nextCheckAt: null, state: "preparing", submissionStartedAt: null },
		});
		expect(await acquire()).toBeNull();
	});

	it("does not finish a lease whose supplied timestamp is stale at the database fence", async () => {
		const suppliedNow = new Date(Date.now() - 60_000);
		await seedOperation({ submissionStartedAt: new Date(suppliedNow.getTime() - 30_000) });
		const lease = await acquire(prisma, ownerId, operationId, suppliedNow);
		expect(lease).not.toBeNull();
		const before = await snapshot();
		expect(
			await finishImportReconcileLease(
				prisma,
				ownerId,
				operationId,
				lease!.token,
				lease!.operation.revision,
				suppliedNow,
				{
					cursor: null,
					nextCheckAt: new Date(suppliedNow.getTime() + 5_000),
					reason: "budget-yield",
				},
			),
		).toBe(false);
		expect(await snapshot()).toEqual(before);
	});

	it("does not admit an operation through another owner's scope", async () => {
		await seedOperation();
		expect(await acquire(peer, otherOwnerId)).toBeNull();
		expect((await snapshot()).reconcileToken).toBeNull();
	});

	it.each(["completed", "not-submitted"])(
		"refuses terminal or unsubmitted state %s",
		async (state) => {
			await seedOperation({ state });
			expect(await acquire()).toBeNull();
		},
	);

	it("takes over an expired lease and makes its old token unable to finish", async () => {
		await seedOperation({
			reconcileToken: "11111111-1111-4111-8111-111111111111",
			reconcileExpiresAt: new Date(now.getTime() - 1),
		});
		const takeover = await acquire(peer);
		expect(takeover).not.toBeNull();
		expect(takeover?.token).not.toBe("11111111-1111-4111-8111-111111111111");
		expect(
			await finishImportReconcileLease(
				prisma,
				ownerId,
				operationId,
				"11111111-1111-4111-8111-111111111111",
				0,
				now,
				{ cursor: null, nextCheckAt: new Date(now.getTime() + 1_000), reason: "budget-yield" },
			),
		).toBe(false);
		expect((await snapshot()).reconcileToken).toBe(takeover?.token);
	});

	it("finishes with a sanitized cursor that survives a second client read", async () => {
		await seedOperation();
		const lease = await acquire();
		expect(lease).not.toBeNull();
		const cursor = validCursor({
			page: 3,
			pageSize: 50,
			totalRecords: 101,
			seenRecords: 100,
			witnesses: [{ fileFingerprint: fileA, fileId: 501, episodeIds: [1001] }],
		});
		expect(await finish(lease!, { cursor, reason: "coverage-incomplete" })).toBe(true);
		const saved = await peer.arrImportOperation.findFirstOrThrow({
			where: { id: operationId, userId: ownerId },
		});
		expect(saved.reconcileCursor).toEqual(cursor);
		expect(saved.reconcileToken).toBeNull();
		expect(saved.reconcileExpiresAt).toBeNull();
		expect(saved.reason).toBe("coverage-incomplete");
		expect(saved.lastCheckedAt).toEqual(now);
		expect(saved.nextCheckAt).toEqual(new Date(now.getTime() + 5_000));
		expect(saved.state).toBe("pending");
		expect(saved.commandId).toBe(42);
		expect(saved.commandFingerprint).toBe(commandFingerprint);
		expect(saved.submissionStartedAt).toEqual(new Date(now.getTime() - 30_000));
		expect(saved.encryptedSources).toBe("synthetic-ciphertext");
		expect(saved.connectionFingerprint).toBe(hash("connection"));
	});

	it("parses persisted cursors against their current operation binding", async () => {
		await seedOperation();
		const operation = await snapshot();
		const cursor = validCursor();
		expect(parseImportReconcileCursor(operation, cursor, now)).toEqual(cursor);
		expect(
			parseImportReconcileCursor(operation, { ...cursor, privateValue: "secret" }, now),
		).toBeNull();
		expect(parseImportReconcileCursor(operation, cursor, new Date(Number.NaN))).toBeNull();
	});

	it("allows the matching lease to finish after evidence advances the operation to completed", async () => {
		await seedOperation();
		const lease = await acquire();
		await prisma.arrImportOperation.update({
			where: { id: operationId },
			data: {
				commandState: "completed",
				commandTerminal: true,
				state: "completed",
				revision: { increment: 1 },
			},
		});
		expect(
			await finishImportReconcileLease(
				prisma,
				ownerId,
				operationId,
				lease!.token,
				lease!.operation.revision + 1,
				now,
				{
					cursor: null,
					nextCheckAt: new Date(now.getTime() + 5_000),
					reason: "coverage-incomplete",
				},
			),
		).toBe(true);
		const saved = await snapshot();
		expect(saved.state).toBe("completed");
		expect(saved.commandState).toBe("completed");
		expect(saved.commandTerminal).toBe(true);
		expect(saved.reconcileToken).toBeNull();
	});

	it("keeps command state, file evidence, and cursor unchanged after stale revision or foreign owner", async () => {
		await seedOperation({ reconcileCursor: validCursor({ page: 2 }) });
		const lease = await acquire();
		expect(lease).not.toBeNull();
		const before = await snapshot();
		expect(
			await finishImportReconcileLease(
				prisma,
				ownerId,
				operationId,
				lease!.token,
				lease!.operation.revision - 1,
				now,
				{
					cursor: null,
					nextCheckAt: new Date(now.getTime() + 1_000),
					reason: "coverage-incomplete",
				},
			),
		).toBe(false);
		expect(
			await finishImportReconcileLease(
				peer,
				otherOwnerId,
				operationId,
				lease!.token,
				lease!.operation.revision,
				now,
				{ cursor: null, nextCheckAt: new Date(now.getTime() + 1_000), reason: "budget-yield" },
			),
		).toBe(false);
		const after = await snapshot();
		expect(after.reconcileCursor).toEqual(before.reconcileCursor);
		expect(after.commandId).toBe(before.commandId);
		expect(after.commandState).toBe(before.commandState);
		expect(after.state).toBe(before.state);
		expect(after.reason).toBe(before.reason);
		expect(after.files).toEqual(before.files);
	});

	it("rejects a late finish without changing the operation", async () => {
		await seedOperation();
		const lease = await acquire();
		await prisma.arrImportOperation.update({
			where: { id: operationId },
			data: { reconcileExpiresAt: new Date(now.getTime() - 1) },
		});
		const before = await snapshot();
		expect(await finish(lease!)).toBe(false);
		expect(await snapshot()).toEqual(before);
	});

	it("accepts null cursor for generic unavailable evidence and only changes lease timing fields", async () => {
		await seedOperation({ commandId: null, state: "unknown" });
		const lease = await acquire();
		expect(lease).not.toBeNull();
		expect(await finish(lease!, { cursor: null, reason: "evidence-unavailable" })).toBe(true);
		const saved = await snapshot();
		expect(saved.reconcileCursor).toBeNull();
		expect(saved.reason).toBe("evidence-unavailable");
		expect(saved.commandId).toBeNull();
		expect(saved.state).toBe("unknown");
	});

	it.each([
		["extra top-level key", validCursor({ privateValue: "secret" } as never)],
		["wrong command", validCursor({ commandId: 99 })],
		["wrong command fingerprint", validCursor({ commandFingerprint: versionedHash("other") })],
		["noncanonical command time", validCursor({ commandEndedAt: "2026-10-01T11:59:59Z" })],
		["command time before submission", validCursor({ commandEndedAt: "2026-10-01T11:59:00.000Z" })],
		["private path", validCursor({ sourcePath: "/private/source.mkv" } as never)],
		["oversized page", validCursor({ page: 1_000_001 })],
		["page cursor without page metadata", validCursor({ page: 2 })],
		["unpaired page metadata", validCursor({ pageSize: 50, totalRecords: null })],
		["too many seen records", validCursor({ pageSize: 10, totalRecords: 2, seenRecords: 3 })],
		["source past end sentinel", validCursor({ sourceIndex: 3 })],
		[
			"wrong source file",
			validCursor({ witnesses: [{ fileFingerprint: fileB, fileId: 502, episodeIds: [1001] }] }),
		],
		[
			"unowned episode",
			validCursor({ witnesses: [{ fileFingerprint: fileA, fileId: 501, episodeIds: [9999] }] }),
		],
		[
			"overlapping ambiguous and witnessed file",
			validCursor({
				witnesses: [{ fileFingerprint: fileA, fileId: 501, episodeIds: [1001] }],
				ambiguousFiles: [fileA],
			}),
		],
		[
			"witness at end sentinel",
			validCursor({
				sourceIndex: 2,
				witnesses: [{ fileFingerprint: fileA, fileId: 501, episodeIds: [1001] }],
			}),
		],
	])("rejects malformed cursor (%s) with no mutation", async (_label, cursor) => {
		await seedOperation();
		const lease = await acquire();
		const before = await snapshot();
		const accepted = await finishImportReconcileLease(
			prisma,
			ownerId,
			operationId,
			lease!.token,
			lease!.operation.revision,
			now,
			{ cursor, nextCheckAt: new Date(now.getTime() + 5_000), reason: "coverage-incomplete" },
		);
		expect(accepted).toBe(false);
		expect(await snapshot()).toEqual(before);
	});

	it("requires non-Sonarr witness episodes to be empty and permits generic empty cursor finish", async () => {
		await seedOperation({ service: "RADARR" });
		const lease = await acquire();
		const invalid = validCursor({
			witnesses: [{ fileFingerprint: fileA, fileId: 501, episodeIds: [1001] }],
		});
		expect(await finish(lease!, { cursor: invalid, reason: "coverage-incomplete" })).toBe(false);
		expect(await finish(lease!, { cursor: null, reason: "evidence-unavailable" })).toBe(true);
	});

	it("accepts a current-source ambiguity list without creating file proof", async () => {
		await seedOperation();
		const lease = await acquire();
		const cursor = validCursor({ ambiguousFiles: [fileA] });
		expect(await finish(lease!, { cursor, reason: "coverage-incomplete" })).toBe(true);
		expect((await snapshot()).reconcileCursor).toEqual(cursor);
		expect(await prisma.arrImportFileProof.count({ where: { operationId } })).toBe(2);
		expect(
			await prisma.arrImportFileProof.count({ where: { operationId, verifiedAt: { not: null } } }),
		).toBe(0);
	});

	it("accepts an empty source-end sentinel cursor", async () => {
		await seedOperation();
		const lease = await acquire();
		const cursor = validCursor({ sourceIndex: 2 });
		expect(await finish(lease!, { cursor, reason: "budget-yield" })).toBe(true);
		expect((await snapshot()).reconcileCursor).toEqual(cursor);
	});

	it("rejects invalid completion deadlines and token shapes without mutation", async () => {
		await seedOperation();
		const lease = await acquire();
		for (const [token, nextCheckAt] of [
			["wrong-token", new Date(now.getTime() + 1_000)],
			[lease!.token, new Date(now.getTime())],
			[lease!.token, new Date(now.getTime() + 86_400_001)],
		] as const) {
			expect(
				await finishImportReconcileLease(
					prisma,
					ownerId,
					operationId,
					token,
					lease!.operation.revision,
					now,
					{ cursor: null, nextCheckAt, reason: "budget-yield" },
				),
			).toBe(false);
		}
		expect((await snapshot()).reconcileToken).toBe(lease?.token);
	});
});
