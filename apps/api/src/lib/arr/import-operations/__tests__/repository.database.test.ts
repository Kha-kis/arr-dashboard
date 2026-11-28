import { execFileSync } from "node:child_process";
import { createHash } from "node:crypto";
import { mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterAll, beforeAll, beforeEach, describe, expect, it } from "vitest";
import { createTestPrismaClient } from "../../../__tests__/test-prisma.js";
import * as repository from "../repository.js";

const databases: Array<{ directory: string; prisma: ReturnType<typeof createTestPrismaClient> }> =
	[];
const now = new Date("2026-10-01T12:00:00.000Z");
const expiresAt = new Date(now.getTime() + 60_000);
const userIds = ["owner-a", "owner-b"] as const;
const instanceIds = ["sonarr-a", "sonarr-b"] as const;
const fingerprints = {
	downloadA: createHash("sha256").update("download-a").digest("hex"),
	downloadB: createHash("sha256").update("download-b").digest("hex"),
	downloadC: createHash("sha256").update("download-c").digest("hex"),
	downloadD: createHash("sha256").update("download-d").digest("hex"),
	downloadE: createHash("sha256").update("download-e").digest("hex"),
};

let prisma: ReturnType<typeof createTestPrismaClient>;
let peerPrisma: ReturnType<typeof createTestPrismaClient>;
let dbPath: string;

function versionedFingerprint(seed: string): string {
	return `v1:${createHash("sha256").update(seed).digest("hex")}`;
}

function file(seed: string, downloadKey = fingerprints.downloadA) {
	return {
		fileFingerprint: versionedFingerprint(seed),
		downloadKey,
		identity: {
			pathHash: createHash("sha256").update(`path:${seed}`).digest("hex"),
			seriesId: 101,
			episodeIds: [1001, 1002],
			episodeFileId: 9001,
		},
	};
}

function attempt(overrides: Record<string, unknown> = {}) {
	return {
		userId: userIds[0],
		instanceId: instanceIds[0],
		connectionFingerprint: connectionFingerprint("sonarr-a"),
		service: "SONARR" as const,
		origin: "manual" as const,
		mode: "Move" as const,
		idempotencyKey: "attempt-key-1",
		requestFingerprint: versionedFingerprint("request-a"),
		commandFingerprint: versionedFingerprint("command-a"),
		encryptedSources: "v1.synthetic-encrypted-source-a",
		sourcesEncryptionIv: "synthetic-iv-a",
		files: [file("file-a")],
		now,
		preparationExpiresAt: expiresAt,
		...overrides,
	};
}

function connectionFingerprint(seed: string): string {
	const index = seed === "sonarr-a" ? 0 : 1;
	return createHash("sha256")
		.update(
			JSON.stringify([
				userIds[index],
				instanceIds[index],
				"SONARR",
				`http://sonarr-${index}.invalid`,
				`synthetic-encrypted-key-${index}`,
				`synthetic-key-iv-${index}`,
				null,
				null,
			]),
		)
		.digest("hex");
}

function api() {
	return repository;
}

async function clearDatabase() {
	await prisma.arrImportFileProof.deleteMany();
	await prisma.arrImportSourceClaim.deleteMany();
	await prisma.arrImportOperation.deleteMany();
	await prisma.queueCleanerImportReceipt.deleteMany();
	await prisma.serviceInstance.deleteMany();
	await prisma.user.deleteMany();
	for (const userId of userIds) {
		await prisma.user.create({ data: { id: userId, username: `synthetic-${userId}` } });
	}
	for (const [index, instanceId] of instanceIds.entries()) {
		const userId = userIds[index];
		if (!userId) throw new Error("expected a synthetic owner for each instance");
		await prisma.serviceInstance.create({
			data: {
				id: instanceId,
				userId,
				service: "SONARR",
				label: `Synthetic Sonarr ${index}`,
				baseUrl: `http://sonarr-${index}.invalid`,
				encryptedApiKey: `synthetic-encrypted-key-${index}`,
				encryptionIv: `synthetic-key-iv-${index}`,
			},
		});
	}
}

async function begin(overrides: Record<string, unknown> = {}) {
	return api().beginImportAttempt(prisma, attempt(overrides) as never);
}

async function created(overrides: Record<string, unknown> = {}) {
	const result = (await begin(overrides)) as { kind: string; operation?: { id: string } };
	if (result.kind !== "created" || !result.operation) throw new Error("expected a created attempt");
	return result.operation.id;
}

async function submit(operationId: string, ownerId = userIds[0]) {
	return api().markImportSubmissionStarted(
		prisma,
		ownerId,
		operationId,
		connectionFingerprint("sonarr-a"),
		new Date(now.getTime() + 1),
	);
}

async function observe(
	operationId: string,
	state: "pending" | "completed" | "failed" | "unknown",
	options: Record<string, unknown> = {},
) {
	const operation = await prisma.arrImportOperation.findUniqueOrThrow({
		where: { id: operationId },
	});
	return api().recordImportCommandObservation(prisma, userIds[0], operationId, {
		expectedRevision: operation.revision,
		connectionFingerprint: connectionFingerprint("sonarr-a"),
		commandFingerprint: versionedFingerprint("command-a"),
		commandId: 42,
		state,
		terminal: state === "completed" || state === "failed",
		checkedAt: new Date(now.getTime() + 2),
		...options,
	} as never);
}

async function verifyFiles(
	operationId: string,
	fileFingerprints: string[],
	options: Record<string, unknown> = {},
) {
	const operation = await prisma.arrImportOperation.findUniqueOrThrow({
		where: { id: operationId },
	});
	return api().recordVerifiedImportFiles(prisma, userIds[0], operationId, {
		expectedRevision: operation.revision,
		connectionFingerprint: connectionFingerprint("sonarr-a"),
		commandFingerprint: versionedFingerprint("command-a"),
		commandId: 42,
		fileFingerprints,
		verifiedAt: new Date(now.getTime() + 3),
		...options,
	} as never);
}

beforeAll(() => {
	const directory = mkdtempSync(join(tmpdir(), "arr-import-repository-"));
	dbPath = join(directory, "test.db");
	execFileSync("pnpm", ["exec", "prisma", "db", "push", "--schema", "prisma/schema.prisma"], {
		cwd: process.cwd(),
		env: { ...process.env, DATABASE_URL: `file:${dbPath}` },
		stdio: "ignore",
	});
	prisma = createTestPrismaClient(`file:${dbPath}`);
	peerPrisma = createTestPrismaClient(`file:${dbPath}`);
	databases.push({ directory, prisma });
}, 30_000);

beforeEach(clearDatabase);

afterAll(async () => {
	await peerPrisma?.$disconnect();
	for (const database of databases.splice(0)) {
		await database.prisma.$disconnect();
		rmSync(database.directory, { recursive: true, force: true });
	}
});

describe("durable ARR import repository", { timeout: 30_000 }, () => {
	it("preserves an exact edition while retaining old edition-less file identities", () => {
		const identity = { pathHash: "a".repeat(64), authorId: 12, bookId: 13 };
		expect(repository.normalizeIdentity("READARR", identity)).toEqual(identity);
		expect(
			repository.normalizeIdentity("READARR", { ...identity, foreignEditionId: "edition-1" }),
		).toEqual({ ...identity, foreignEditionId: "edition-1" });
		for (const foreignEditionId of ["", " edition", "x".repeat(1025), null]) {
			expect(repository.normalizeIdentity("READARR", { ...identity, foreignEditionId })).toBeNull();
		}
		expect(
			repository.normalizeIdentity("LIDARR", {
				pathHash: identity.pathHash,
				artistId: 12,
				albumId: 13,
				foreignEditionId: "edition-1",
			}),
		).toBeNull();
	});
	it.each([
		["invalid versioned fingerprint", { requestFingerprint: "not-a-fingerprint" }],
		["raw top-level path", { path: "/private/source.mkv" }],
		[
			"raw identity path",
			{
				files: [
					{
						...file("raw-path"),
						identity: { ...file("raw-path").identity, path: "/private/source.mkv" },
					},
				],
			},
		],
		[
			"unknown identity coordinate",
			{
				files: [
					{
						...file("unknown-coordinate"),
						identity: { ...file("unknown-coordinate").identity, movieId: 3 },
					},
				],
			},
		],
		[
			"nonpositive media identifier",
			{
				files: [
					{
						...file("invalid-media-id"),
						identity: { ...file("invalid-media-id").identity, seriesId: 0 },
					},
				],
			},
		],
		[
			"duplicate file fingerprint",
			{ files: [file("duplicate"), file("duplicate", fingerprints.downloadB)] },
		],
		["expired preparation", { preparationExpiresAt: now }],
	])("rejects %s before creating any rows", async (_label, overrides) => {
		await expect(begin(overrides)).rejects.toMatchObject({ reason: "invalid-attempt" });
		expect(await prisma.arrImportOperation.count()).toBe(0);
		expect(await prisma.arrImportFileProof.count()).toBe(0);
		expect(await prisma.arrImportSourceClaim.count()).toBe(0);
	});

	it("returns the original operation for a matching key despite randomized lookup ciphertext", async () => {
		const first = (await begin()) as { operation: { id: string; encryptedSources: string } };
		const second = (await begin({
			encryptedSources: "v1.randomized-encryption-of-same-verified-sources",
			sourcesEncryptionIv: "synthetic-randomized-iv-b",
		})) as { kind: string; operation: { id: string; encryptedSources: string } };

		expect(first.operation.id).toBe(second.operation.id);
		expect(second.kind).toBe("existing");
		expect(second.operation.encryptedSources).toBe("v1.synthetic-encrypted-source-a");
		expect(await prisma.arrImportOperation.count()).toBe(1);
	});

	it.each([
		["mode", { mode: "Copy" }],
		["selection", { files: [file("different-file")] }],
		["origin", { origin: "queue-cleaner" }],
		["request", { requestFingerprint: versionedFingerprint("different-request") }],
		["command", { commandFingerprint: versionedFingerprint("different-command") }],
	])("rejects same-key immutable %s changes", async (_label, overrides) => {
		await begin();
		await expect(begin(overrides)).rejects.toMatchObject({ reason: "idempotency-conflict" });
	});

	it("rejects a changed connection fingerprint before creating work", async () => {
		await expect(
			begin({ connectionFingerprint: connectionFingerprint("wrong") }),
		).rejects.toMatchObject({
			reason: "connection-changed",
		});
		expect(await prisma.arrImportOperation.count()).toBe(0);
	});

	it("keeps idempotency and source claims independent across owners", async () => {
		const first = await begin();
		const second = (await api().beginImportAttempt(
			prisma,
			attempt({
				userId: userIds[1],
				instanceId: instanceIds[1],
				connectionFingerprint: connectionFingerprint("sonarr-b"),
			}) as never,
		)) as { kind: string; operation: { id: string } };
		expect((first as { operation: { id: string } }).operation.id).not.toBe(second.operation.id);
		expect(second.kind).toBe("created");
		expect(
			await api().readOwnedImportAttempt(
				prisma,
				userIds[1],
				(first as { operation: { id: string } }).operation.id,
			),
		).toBeNull();
	});

	it("returns protected sources without leaving partial files or claims", async () => {
		await begin({ files: [file("first"), file("second", fingerprints.downloadB)] });
		const result = await begin({
			idempotencyKey: "attempt-key-2",
			files: [
				file("overlap"),
				file("would-be-partial", createHash("sha256").update("download-c").digest("hex")),
			],
		});
		expect(result).toEqual({ kind: "protected", downloadKeys: [fingerprints.downloadA] });
		expect(await prisma.arrImportOperation.count()).toBe(1);
		expect(await prisma.arrImportFileProof.count()).toBe(2);
		expect(await prisma.arrImportSourceClaim.count()).toBe(2);
	});

	it("fails closed on a dangling active claim", async () => {
		await prisma.arrImportSourceClaim.create({
			data: {
				userId: userIds[0],
				downloadKey: fingerprints.downloadC,
				activeOperationId: "missing-operation",
			},
		});
		expect(
			await begin({
				idempotencyKey: "dangling-claim",
				files: [file("dangling", fingerprints.downloadC)],
			}),
		).toEqual({
			kind: "protected",
			downloadKeys: [fingerprints.downloadC],
		});
		expect(await prisma.arrImportOperation.count()).toBe(0);
		expect(await prisma.arrImportFileProof.count()).toBe(0);
	});

	it("blocks an overlapping same-owner alias and an owned disabled connection", async () => {
		await prisma.serviceInstance.create({
			data: {
				id: "sonarr-a-alias",
				userId: userIds[0],
				service: "SONARR",
				label: "Synthetic Sonarr alias",
				baseUrl: "http://sonarr-alias.invalid",
				encryptedApiKey: "synthetic-alias-key",
				encryptionIv: "synthetic-alias-iv",
			},
		});
		await begin();
		const alias = await api().beginImportAttempt(
			prisma,
			attempt({
				instanceId: "sonarr-a-alias",
				connectionFingerprint: createHash("sha256")
					.update(
						JSON.stringify([
							userIds[0],
							"sonarr-a-alias",
							"SONARR",
							"http://sonarr-alias.invalid",
							"synthetic-alias-key",
							"synthetic-alias-iv",
							null,
							null,
						]),
					)
					.digest("hex"),
				idempotencyKey: "alias-attempt",
			}) as never,
		);
		expect(alias).toEqual({ kind: "protected", downloadKeys: [fingerprints.downloadA] });

		await prisma.serviceInstance.update({
			where: { id: instanceIds[1] },
			data: { enabled: false },
		});
		await expect(
			api().beginImportAttempt(
				prisma,
				attempt({
					userId: userIds[1],
					instanceId: instanceIds[1],
					connectionFingerprint: connectionFingerprint("sonarr-b"),
				}) as never,
			),
		).rejects.toMatchObject({ reason: "connection-changed" });
		await expect(
			api().beginImportAttempt(
				prisma,
				attempt({
					instanceId: instanceIds[1],
					connectionFingerprint: connectionFingerprint("sonarr-b"),
				}) as never,
			),
		).rejects.toMatchObject({ reason: "connection-changed" });
	});

	it("settles duplicate idempotency key races across independent SQLite clients", async () => {
		const outcomes = await Promise.allSettled([
			api().beginImportAttempt(prisma, attempt() as never),
			api().beginImportAttempt(peerPrisma, attempt() as never),
		]);
		expect(outcomes.every((outcome) => outcome.status === "fulfilled")).toBe(true);
		const kinds = outcomes
			.map((outcome) => (outcome as PromiseFulfilledResult<{ kind: string }>).value.kind)
			.sort();
		expect(kinds).toEqual(["created", "existing"]);
		expect(await prisma.arrImportOperation.count()).toBe(1);
		expect(await prisma.arrImportFileProof.count()).toBe(1);
		expect(await prisma.arrImportSourceClaim.count()).toBe(1);
	});

	it("atomically rejects one independent multi-source acquisition race", async () => {
		const overlap = file("shared", fingerprints.downloadA);
		const losingOnly = file("loser-only", fingerprints.downloadB);
		const winnerOnly = file("winner-only", createHash("sha256").update("download-c").digest("hex"));
		const outcomes = await Promise.allSettled([
			api().beginImportAttempt(
				prisma,
				attempt({ idempotencyKey: "race-a", files: [overlap, winnerOnly] }) as never,
			),
			api().beginImportAttempt(
				peerPrisma,
				attempt({ idempotencyKey: "race-b", files: [file("shared-b"), losingOnly] }) as never,
			),
		]);
		const successful = outcomes.filter(
			(outcome) => outcome.status === "fulfilled",
		) as PromiseFulfilledResult<{ kind: string; operation?: { id: string } }>[];
		expect(successful).toHaveLength(2);
		expect(successful.filter((outcome) => outcome.value.kind === "created")).toHaveLength(1);
		expect(successful.filter((outcome) => outcome.value.kind === "protected")).toHaveLength(1);
		expect(await prisma.arrImportOperation.count()).toBe(1);
		expect(await prisma.arrImportFileProof.count()).toBe(2);
		expect(await prisma.arrImportSourceClaim.count()).toBe(2);
		expect(
			await prisma.arrImportFileProof.findFirst({ where: { downloadKey: fingerprints.downloadB } }),
		).toBeNull();
	});

	it.each(["submitting", "pending", "unknown", "completed", "failed", "legacy-unrecognized"])(
		"treats owned legacy receipt state %s as preparation protection",
		async (state) => {
			await prisma.queueCleanerImportReceipt.create({
				data: {
					instanceId: instanceIds[0],
					downloadKey: fingerprints.downloadA,
					queueId: 1,
					downloadTitle: "Synthetic source",
					connectionFingerprint: connectionFingerprint("sonarr-a"),
					commandFingerprint: versionedFingerprint("legacy-command"),
					state,
					lastAttemptAt: now,
				},
			});
			expect(await begin()).toEqual({ kind: "protected", downloadKeys: [fingerprints.downloadA] });
			expect(await prisma.arrImportOperation.count()).toBe(0);
		},
	);

	it("allows cancellation only before submission and blocks an expired held preparer", async () => {
		const canceled = await created({ idempotencyKey: "cancel-me" });
		expect(await api().cancelUnsubmittedImportAttempt(prisma, userIds[0], canceled)).toBe(true);
		expect(await submit(canceled)).toBe(false);
		expect(await prisma.arrImportSourceClaim.findFirstOrThrow()).toMatchObject({
			activeOperationId: null,
		});

		const expired = await created({
			idempotencyKey: "expired-preparer",
			now: new Date(now.getTime() - 120_000),
			preparationExpiresAt: new Date(now.getTime() - 60_000),
		});
		expect(await submit(expired)).toBe(false);
	});

	it("allows only one submission transition and rechecks connection credentials", async () => {
		const operationId = await created();
		expect(await submit(operationId)).toBe(true);
		expect(await submit(operationId)).toBe(false);
		const other = await created({
			idempotencyKey: "other-key",
			files: [file("different", fingerprints.downloadB)],
		});
		await prisma.serviceInstance.update({
			where: { id: instanceIds[0] },
			data: { encryptedApiKey: "synthetic-rotated-api-key" },
		});
		expect(await submit(other)).toBe(false);
	});

	it("marks aggregate completion unknown until every selected file is positively verified", async () => {
		const operationId = await created({
			files: [file("one"), file("two", fingerprints.downloadB)],
		});
		expect(await submit(operationId)).toBe(true);
		expect(await observe(operationId, "completed")).toBe(true);
		const operation = await prisma.arrImportOperation.findUniqueOrThrow({
			where: { id: operationId },
		});
		expect(operation).toMatchObject({
			state: "unknown",
			commandState: "completed",
			commandTerminal: true,
			verifiedFileCount: 0,
		});
	});

	it("persists a lost submission acknowledgement as unknown without inventing a command ID", async () => {
		const operationId = await created();
		expect(await submit(operationId)).toBe(true);
		expect(await observe(operationId, "unknown", { commandId: undefined })).toBe(true);
		const operation = await prisma.arrImportOperation.findUniqueOrThrow({
			where: { id: operationId },
		});
		expect(operation).toMatchObject({
			state: "unknown",
			commandState: "unknown",
			commandId: null,
			commandTerminal: false,
		});
		expect(await begin({ idempotencyKey: "must-remain-protected" })).toEqual({
			kind: "protected",
			downloadKeys: [fingerprints.downloadA],
		});

		const established = await created({
			idempotencyKey: "known-command-then-unknown",
			files: [file("known-command", fingerprints.downloadB)],
		});
		await submit(established);
		expect(await observe(established, "pending")).toBe(true);
		expect(await observe(established, "unknown", { commandId: undefined })).toBe(true);
		expect(
			await prisma.arrImportOperation.findUniqueOrThrow({ where: { id: established } }),
		).toMatchObject({
			state: "unknown",
			commandId: 42,
			commandTerminal: false,
		});
	});

	it("records a positive subset without inventing file evidence or rewriting timestamps", async () => {
		const operationId = await created({
			files: [file("one"), file("two", fingerprints.downloadB)],
		});
		await submit(operationId);
		await observe(operationId, "pending");
		const fingerprint = versionedFingerprint("one");
		expect(await verifyFiles(operationId, [fingerprint])).toBe(true);
		await prisma.arrImportFileProof.update({
			where: { operationId_fileFingerprint: { operationId, fileFingerprint: fingerprint } },
			data: { verifiedAt: new Date(now.getTime() + 5000) },
		});
		expect(await verifyFiles(operationId, [fingerprint])).toBe(true);
		const proof = await prisma.arrImportFileProof.findUniqueOrThrow({
			where: { operationId_fileFingerprint: { operationId, fileFingerprint: fingerprint } },
		});
		expect(proof.verifiedAt).toEqual(new Date(now.getTime() + 5000));
		expect(await verifyFiles(operationId, [versionedFingerprint("invented")])).toBe(false);
		const operation = await prisma.arrImportOperation.findUniqueOrThrow({
			where: { id: operationId },
		});
		expect(operation).toMatchObject({ state: "pending", verifiedFileCount: 1 });
	});

	it.each([
		["failed", "partial"],
		["completed", "partial"],
	])(
		"keeps terminal %s batches partial with only one verified file",
		async (commandState, expectedState) => {
			const operationId = await created({
				files: [file("one"), file("two", fingerprints.downloadB)],
			});
			await submit(operationId);
			await observe(operationId, commandState as "failed" | "completed");
			await verifyFiles(operationId, [versionedFingerprint("one")]);
			expect(
				await prisma.arrImportOperation.findUniqueOrThrow({ where: { id: operationId } }),
			).toMatchObject({
				state: expectedState,
				commandTerminal: true,
				verifiedFileCount: 1,
			});
		},
	);

	it.each(["failed", "completed"])(
		"completes terminal %s commands only after all files are verified",
		async (commandState) => {
			const operationId = await created({
				files: [file("one"), file("two", fingerprints.downloadB)],
			});
			await submit(operationId);
			await observe(operationId, commandState as "failed" | "completed");
			await verifyFiles(operationId, [versionedFingerprint("one"), versionedFingerprint("two")]);
			expect(
				await prisma.arrImportOperation.findUniqueOrThrow({ where: { id: operationId } }),
			).toMatchObject({
				state: "completed",
				commandTerminal: true,
				verifiedFileCount: 2,
			});
		},
	);

	it("rejects stale revisions, changed connection evidence, command mismatches, and unknown file IDs", async () => {
		const operationId = await created();
		await submit(operationId);
		const operation = await prisma.arrImportOperation.findUniqueOrThrow({
			where: { id: operationId },
		});
		const wrongRevision = await api().recordImportCommandObservation(
			prisma,
			userIds[0],
			operationId,
			{
				expectedRevision: operation.revision - 1,
				connectionFingerprint: connectionFingerprint("sonarr-a"),
				commandFingerprint: versionedFingerprint("command-a"),
				commandId: 42,
				state: "pending",
				terminal: false,
				checkedAt: now,
			} as never,
		);
		expect(wrongRevision).toBe(false);
		expect(
			await observe(operationId, "pending", {
				connectionFingerprint: connectionFingerprint("wrong"),
			}),
		).toBe(false);
		expect(
			await observe(operationId, "pending", {
				commandFingerprint: versionedFingerprint("wrong-command"),
			}),
		).toBe(false);
		expect(await observe(operationId, "pending", { commandId: -1 })).toBe(false);
		expect(await observe(operationId, "pending")).toBe(true);
		expect(await observe(operationId, "pending", { commandId: 43 })).toBe(false);
		expect(await verifyFiles(operationId, [versionedFingerprint("missing")])).toBe(false);
		expect(
			await verifyFiles(operationId, [versionedFingerprint("file-a")], {
				expectedRevision: operation.revision - 1,
			}),
		).toBe(false);
		expect(
			await prisma.arrImportFileProof.findUniqueOrThrow({
				where: {
					operationId_fileFingerprint: {
						operationId,
						fileFingerprint: versionedFingerprint("file-a"),
					},
				},
			}),
		).toMatchObject({ verifiedAt: null });
	});

	it("does not downgrade completed evidence after later unknown observations or provider pruning", async () => {
		const operationId = await created();
		await submit(operationId);
		await observe(operationId, "failed");
		await verifyFiles(operationId, [versionedFingerprint("file-a")]);
		const terminal = await prisma.arrImportOperation.findUniqueOrThrow({
			where: { id: operationId },
		});
		expect(terminal.state).toBe("completed");
		await api().recordImportCommandObservation(prisma, userIds[0], operationId, {
			expectedRevision: terminal.revision,
			connectionFingerprint: connectionFingerprint("sonarr-a"),
			commandFingerprint: versionedFingerprint("command-a"),
			state: "unknown",
			terminal: false,
			checkedAt: new Date(now.getTime() + 10),
		} as never);
		expect(
			await prisma.arrImportOperation.findUniqueOrThrow({ where: { id: operationId } }),
		).toMatchObject({
			state: "completed",
			commandId: 42,
			commandTerminal: true,
			verifiedFileCount: 1,
		});
	});

	it("requires current credentials to record new file proof", async () => {
		const operationId = await created();
		await submit(operationId);
		await observe(operationId, "pending");
		await prisma.serviceInstance.update({
			where: { id: instanceIds[0] },
			data: { baseUrl: "http://rotated.invalid" },
		});
		expect(await verifyFiles(operationId, [versionedFingerprint("file-a")])).toBe(false);
	});

	it("releases only terminal or explicitly unsubmitted claims and preserves other owners", async () => {
		const unknown = await created({ idempotencyKey: "unknown" });
		await submit(unknown);
		await observe(unknown, "unknown");
		expect(await api().releaseTerminalImportSources(prisma, userIds[0], unknown)).toBe(false);

		const finished = await created({
			idempotencyKey: "finished",
			files: [file("finished", fingerprints.downloadB)],
		});
		await submit(finished);
		await observe(finished, "failed");
		await prisma.arrImportSourceClaim.create({
			data: {
				userId: userIds[0],
				downloadKey: fingerprints.downloadC,
				activeOperationId: "dangling-other-operation",
			},
		});
		expect(await api().releaseTerminalImportSources(prisma, userIds[0], finished)).toBe(true);
		expect(
			await prisma.arrImportSourceClaim.findUniqueOrThrow({
				where: { userId_downloadKey: { userId: userIds[0], downloadKey: fingerprints.downloadC } },
			}),
		).toMatchObject({
			activeOperationId: "dangling-other-operation",
		});
		expect(await api().releaseTerminalImportSources(prisma, userIds[0], finished)).toBe(false);
	});

	it("allows an explicit new action after claim release while retaining historical protection", async () => {
		const original = await created({ files: [file("file-a"), file("remaining")] });
		await submit(original);
		await observe(original, "failed");
		await verifyFiles(original, [versionedFingerprint("file-a")]);
		expect(await api().releaseTerminalImportSources(prisma, userIds[0], original)).toBe(true);
		const next = await begin({
			idempotencyKey: "explicit-remainder",
			remainderOf: original,
			now: new Date(now.getTime() + 4),
			files: [file("remaining", fingerprints.downloadA)],
		});
		expect(next).toMatchObject({ kind: "created" });
		const protections = await api().findImportSourceProtection(prisma, userIds[0], [
			fingerprints.downloadA,
		]);
		expect(protections).toEqual(
			expect.arrayContaining([
				expect.objectContaining({ kind: "operation", operationId: original, state: "partial" }),
			]),
		);
	});
	it("protects automatic non-submission without borrowing another owner's or manual cancellation", async () => {
		const automatic = await created({ origin: "queue-cleaner" });
		expect(await api().cancelUnsubmittedImportAttempt(prisma, userIds[0], automatic)).toBe(true);
		const manual = await created({
			idempotencyKey: "cancelled-manual",
			files: [file("manual", fingerprints.downloadB)],
		});
		expect(await api().cancelUnsubmittedImportAttempt(prisma, userIds[0], manual)).toBe(true);
		expect(
			await api().findImportSourceProtection(prisma, userIds[0], [
				fingerprints.downloadA,
				fingerprints.downloadB,
			]),
		).toEqual([
			expect.objectContaining({
				kind: "operation",
				operationId: automatic,
				state: "not-submitted",
				commandTerminal: false,
				automaticRetryInstanceId: instanceIds[0],
			}),
		]);
		expect(
			await api().findImportSourceProtection(prisma, userIds[1], [fingerprints.downloadA]),
		).toEqual([]);
		expect(await begin({ idempotencyKey: "deliberate-manual" })).toMatchObject({ kind: "created" });
	});
	it.each([
		{ submissionStartedAt: now },
		{ commandId: 42 },
		{ commandState: "failed" },
		{ commandTerminal: true },
		{ verifiedFileCount: 1 },
	])("denies an automatic retry hint for contradictory non-submission: %j", async (corruption) => {
		const automatic = await created({ origin: "queue-cleaner" });
		await api().cancelUnsubmittedImportAttempt(prisma, userIds[0], automatic);
		await prisma.arrImportOperation.update({
			where: { id: automatic, userId: userIds[0] },
			data: corruption,
		});
		const protections = await api().findImportSourceProtection(prisma, userIds[0], [
			fingerprints.downloadA,
		]);
		expect(protections).toEqual([
			expect.objectContaining({ operationId: automatic, state: "unknown", commandTerminal: false }),
		]);
		expect(protections[0]).not.toHaveProperty("automaticRetryInstanceId");
	});
	it.each([
		"remaining",
		"positive",
		"mixed",
		"ambiguous",
		"provisional",
		"remapped",
		"foreign-episode",
	])("checks %s Sonarr coordinates against retained covered evidence", async (kind) => {
		const original = await created();
		await submit(original);
		await observe(original, "failed");
		await api().releaseTerminalImportSources(prisma, userIds[0], original);
		const witness = {
			fileFingerprint: versionedFingerprint("file-a"),
			fileId: 31,
			episodeIds: [1001],
		};
		const cursor = {
			version: 2,
			commandFingerprint: versionedFingerprint("command-a"),
			commandId: 42,
			commandEndedAt: new Date(now.getTime() + 2).toISOString(),
			sourceIndex: kind === "provisional" ? 0 : 1,
			page: 1,
			pageSize: null,
			totalRecords: null,
			seenRecords: 0,
			witnesses: kind === "provisional" ? [witness] : [],
			ambiguousFiles: [],
			retainedWitnesses: kind === "ambiguous" || kind === "provisional" ? [] : [witness],
			retainedAmbiguousFiles: kind === "ambiguous" ? [witness.fileFingerprint] : [],
		};
		await prisma.arrImportOperation.updateMany({
			where: { id: original, userId: userIds[0] },
			data: { reconcileCursor: cursor },
		});
		const selected = {
			...file("file-a"),
			fileFingerprint: versionedFingerprint("subset"),
			identity: {
				...file("file-a").identity,
				episodeIds:
					kind === "positive"
						? [1001]
						: kind === "mixed"
							? [1001, 1002]
							: kind === "foreign-episode"
								? [9999]
								: [1002],
				seriesId: kind === "remapped" ? 999 : 101,
			},
		};
		expect(
			await begin({
				idempotencyKey: "covered-subset",
				remainderOf: original,
				now: new Date(now.getTime() + 4),
				files: [selected],
			}),
		).toMatchObject({ kind: kind === "remaining" ? "created" : "protected" });
		expect(await api().readOwnedImportAttempt(prisma, userIds[0], original)).toMatchObject({
			state: "failed",
			verifiedFileCount: 0,
			reconcileCursor: cursor,
		});
	});
	it("rechecks a newly retained episode fact before the remaining subset starts submission", async () => {
		const original = await created();
		await submit(original);
		await observe(original, "failed");
		await api().releaseTerminalImportSources(prisma, userIds[0], original);
		const cursor = {
			version: 2,
			commandFingerprint: versionedFingerprint("command-a"),
			commandId: 42,
			commandEndedAt: new Date(now.getTime() + 2).toISOString(),
			sourceIndex: 1,
			page: 1,
			pageSize: null,
			totalRecords: null,
			seenRecords: 0,
			witnesses: [],
			ambiguousFiles: [],
			retainedWitnesses: [
				{ fileFingerprint: versionedFingerprint("file-a"), fileId: 31, episodeIds: [1001] },
			],
			retainedAmbiguousFiles: [],
		};
		await prisma.arrImportOperation.updateMany({
			where: { id: original, userId: userIds[0] },
			data: { reconcileCursor: cursor },
		});
		const next = await begin({
			idempotencyKey: "late-covered-subset",
			remainderOf: original,
			now: new Date(now.getTime() + 4),
			files: [
				{
					...file("file-a"),
					fileFingerprint: versionedFingerprint("subset"),
					identity: { ...file("file-a").identity, episodeIds: [1002] },
				},
			],
		});
		expect(next.kind).toBe("created");
		if (next.kind !== "created") throw new Error("Expected a synthetic remainder");
		const changed = {
			...cursor,
			retainedWitnesses: [{ ...cursor.retainedWitnesses[0]!, episodeIds: [1001, 1002] }],
		};
		await prisma.arrImportOperation.updateMany({
			where: { id: original, userId: userIds[0] },
			data: { reconcileCursor: changed },
		});
		expect(
			await api().markImportSubmissionStarted(
				prisma,
				userIds[0],
				next.operation.id,
				connectionFingerprint("sonarr-a"),
				new Date(now.getTime() + 5),
				undefined,
				{ operationId: original, selectionFingerprint: versionedFingerprint("request-a") },
			),
		).toBe(false);
		expect(await api().readOwnedImportAttempt(prisma, userIds[0], original)).toMatchObject({
			reconcileCursor: changed,
			verifiedFileCount: 0,
		});
	});

	it.each(["command-id", "terminal", "count", "identity", "owner", "mode", "connection", "state"])(
		"does not admit a remainder with invalid predecessor %s evidence",
		async (invalid) => {
			const original = await created();
			await submit(original);
			await observe(original, "failed");
			await api().releaseTerminalImportSources(prisma, userIds[0], original);
			if (invalid === "identity")
				await prisma.arrImportFileProof.updateMany({
					where: { operationId: original, operation: { userId: userIds[0] } },
					data: { identityJson: { pathHash: "invalid" } },
				});
			else
				await prisma.arrImportOperation.updateMany({
					where: { id: original, userId: userIds[0] },
					data:
						invalid === "command-id"
							? { commandId: null }
							: invalid === "terminal"
								? { commandTerminal: false }
								: invalid === "count"
									? { verifiedFileCount: 1 }
									: invalid === "owner"
										? { userId: userIds[1] }
										: invalid === "mode"
											? { mode: "Copy" }
											: invalid === "state"
												? { state: "completed" }
												: { connectionFingerprint: "f".repeat(64) },
				});
			expect(
				await begin({
					idempotencyKey: "new-remainder",
					remainderOf: original,
					now: new Date(now.getTime() + 4),
				}),
			).toMatchObject({ kind: "protected" });
			expect(await prisma.arrImportOperation.count()).toBe(1);
		},
	);
	it("does not use a same-owner alias as predecessor command authority", async () => {
		const original = await created();
		await submit(original);
		await observe(original, "failed");
		await api().releaseTerminalImportSources(prisma, userIds[0], original);
		await prisma.serviceInstance.create({
			data: {
				id: "alias",
				userId: userIds[0],
				service: "SONARR",
				label: "Synthetic alias",
				baseUrl: "http://alias.invalid",
				encryptedApiKey: "cipher",
				encryptionIv: "iv",
			},
		});
		const { importConnectionFingerprint } = await import(
			"../../../queue-cleaner/import-receipt.js"
		);
		const instance = await prisma.serviceInstance.findFirstOrThrow({
			where: { id: "alias", userId: userIds[0] },
		});
		expect(
			await begin({
				idempotencyKey: "alias-remainder",
				remainderOf: original,
				instanceId: "alias",
				connectionFingerprint: importConnectionFingerprint(instance),
				now: new Date(now.getTime() + 4),
			}),
		).toMatchObject({ kind: "protected" });
	});
	it("checks historical rows after a full page rather than capping lifetime evidence", async () => {
		const original = await created();
		await submit(original);
		await observe(original, "failed");
		await api().releaseTerminalImportSources(prisma, userIds[0], original);
		const template = await prisma.arrImportOperation.findFirstOrThrow({
			where: { id: original, userId: userIds[0] },
			include: { files: true },
		});
		const { id: _id, files: _files, reconcileCursor: _cursor, ...data } = template;
		for (let index = 0; index < 21; index++)
			await prisma.arrImportOperation.create({
				data: {
					...data,
					id: `page-${String(index).padStart(2, "0")}`,
					idempotencyKey: `history-${index}`,
					files: {
						create: {
							fileFingerprint: versionedFingerprint(`history-${index}`),
							downloadKey: fingerprints.downloadA,
							identityJson: file("file-a").identity,
						},
					},
				},
			});
		const allowed = await begin({
			idempotencyKey: "allowed-after-page",
			remainderOf: original,
			now: new Date(now.getTime() + 4),
		});
		expect(allowed.kind).toBe("created");
		if (allowed.kind !== "created") throw new Error("Expected paginated safe synthetic admission");
		expect(
			await api().cancelUnsubmittedImportAttempt(prisma, userIds[0], allowed.operation.id),
		).toBe(true);
		await prisma.arrImportOperation.updateMany({
			where: { id: "page-20", userId: userIds[0] },
			data: { commandTerminal: false, commandState: "unknown", state: "unknown" },
		});
		expect(
			await begin({
				idempotencyKey: "remaining-after-page",
				remainderOf: original,
				now: new Date(now.getTime() + 4),
			}),
		).toMatchObject({ kind: "protected" });
	});
	it.each(["linked", "missing-link", "mismatched-command", "late-change"])(
		"keeps legacy receipts intact for %s remainder admission",
		async (state) => {
			const original = await created();
			await submit(original);
			await observe(original, "failed");
			await api().releaseTerminalImportSources(prisma, userIds[0], original);
			const receipt = await prisma.queueCleanerImportReceipt.create({
				data: {
					id: "legacy",
					queueId: 7,
					downloadTitle: "Synthetic legacy download",
					instanceId: instanceIds[0],
					downloadKey: fingerprints.downloadA,
					connectionFingerprint: connectionFingerprint("sonarr-a"),
					commandFingerprint: versionedFingerprint("command-a"),
					commandId: 42,
					state: "failed",
					lastAttemptAt: new Date(now.getTime() + 1),
					updatedAt: new Date(now.getTime() + 2),
				},
			});
			if (state !== "missing-link")
				await prisma.arrImportOperation.updateMany({
					where: { id: original, userId: userIds[0] },
					data: { legacyReceiptId: receipt.id },
				});
			if (state === "mismatched-command")
				await prisma.queueCleanerImportReceipt.updateMany({
					where: { id: receipt.id, instance: { userId: userIds[0] } },
					data: { commandId: 99 },
				});
			const request = attempt({
				idempotencyKey: "new-legacy-remainder",
				remainderOf: original,
				now: new Date(now.getTime() + 3),
			});
			const result = await api().beginImportAttempt(prisma, request);
			if (state === "linked" || state === "late-change") {
				expect(result.kind).toBe("created");
				if (result.kind !== "created") throw new Error("Expected a created synthetic remainder");
				if (state === "late-change")
					await prisma.queueCleanerImportReceipt.updateMany({
						where: { id: receipt.id, instance: { userId: userIds[0] } },
						data: { commandId: 99 },
					});
				expect(
					await api().markImportSubmissionStarted(
						prisma,
						userIds[0],
						result.operation.id,
						connectionFingerprint("sonarr-a"),
						new Date(now.getTime() + 4),
						undefined,
						{ operationId: original, selectionFingerprint: request.requestFingerprint },
					),
				).toBe(state === "linked");
			} else expect(result.kind).toBe("protected");
			expect(await prisma.queueCleanerImportReceipt.count()).toBe(1);
			if (state === "linked")
				expect(
					await prisma.queueCleanerImportReceipt.findFirst({
						where: { id: receipt.id, instance: { userId: userIds[0] } },
					}),
				).toEqual(receipt);
		},
	);

	it("returns legacy, historical, active, and dangling protection only for the owner", async () => {
		await prisma.queueCleanerImportReceipt.create({
			data: {
				instanceId: instanceIds[0],
				downloadKey: fingerprints.downloadA,
				queueId: 2,
				downloadTitle: "Synthetic legacy source",
				connectionFingerprint: connectionFingerprint("sonarr-a"),
				commandFingerprint: versionedFingerprint("legacy"),
				state: "failed",
				lastAttemptAt: now,
			},
		});
		const terminal = await created({ files: [file("terminal", fingerprints.downloadB)] });
		await submit(terminal);
		await observe(terminal, "completed");
		await verifyFiles(terminal, [versionedFingerprint("terminal")]);
		const unresolved = await created({
			idempotencyKey: "unresolved",
			files: [file("unresolved", fingerprints.downloadC)],
		});
		await submit(unresolved);
		await observe(unresolved, "unknown");
		const canceled = await created({
			idempotencyKey: "canceled",
			files: [file("canceled", fingerprints.downloadE)],
		});
		await api().cancelUnsubmittedImportAttempt(prisma, userIds[0], canceled);
		await prisma.queueCleanerImportReceipt.create({
			data: {
				instanceId: instanceIds[0],
				downloadKey: fingerprints.downloadE,
				queueId: 3,
				downloadTitle: "Synthetic unknown legacy source",
				connectionFingerprint: connectionFingerprint("sonarr-a"),
				commandFingerprint: versionedFingerprint("unknown-legacy-command"),
				state: "unknown",
				lastAttemptAt: now,
			},
		});
		await prisma.arrImportSourceClaim.create({
			data: {
				userId: userIds[0],
				downloadKey: fingerprints.downloadD,
				activeOperationId: "missing-operation",
			},
		});
		await prisma.arrImportOperation.update({
			where: { id: unresolved },
			data: { state: "private-error-detail" },
		});
		const protection = await api().findImportSourceProtection(prisma, userIds[0], [
			fingerprints.downloadA,
			fingerprints.downloadB,
			fingerprints.downloadC,
			fingerprints.downloadD,
			fingerprints.downloadE,
		]);
		expect(protection).toEqual(
			expect.arrayContaining([
				expect.objectContaining({ kind: "legacy", state: "failed", commandTerminal: false }),
				expect.objectContaining({ kind: "legacy", state: "unknown", commandTerminal: false }),
				expect.objectContaining({
					kind: "operation",
					operationId: terminal,
					state: "completed",
					commandTerminal: true,
				}),
				expect.objectContaining({
					kind: "operation",
					operationId: unresolved,
					state: "unknown",
					commandTerminal: false,
				}),
				expect.objectContaining({ kind: "claim", state: "unknown" }),
			]),
		);
		expect(protection).not.toEqual(
			expect.arrayContaining([expect.objectContaining({ operationId: canceled })]),
		);
		const danglingClaim = protection.find(
			(entry) => entry.kind === "claim" && entry.downloadKey === fingerprints.downloadD,
		);
		expect(danglingClaim).toMatchObject({ state: "unknown", commandTerminal: false });
		expect(danglingClaim).not.toHaveProperty("operationId");
		expect(
			await api().findImportSourceProtection(prisma, userIds[1], [
				fingerprints.downloadA,
				fingerprints.downloadB,
				fingerprints.downloadC,
				fingerprints.downloadD,
				fingerprints.downloadE,
			]),
		).toEqual([]);
	});

	it.each(
		["omitted", "wrong", "expired"].flatMap((kind) =>
			["command", "file"].map((action) => ({ kind, action })),
		),
	)("refuses $action evidence from a $kind reconciliation lease", async ({ kind, action }) => {
		const operationId = await created();
		await submit(operationId);
		await observe(operationId, "pending");
		await prisma.arrImportOperation.updateMany({
			where: { id: operationId, userId: userIds[0] },
			data: {
				reconcileToken: "current-worker",
				reconcileExpiresAt: new Date(Date.now() + (kind === "expired" ? -1 : 60_000)),
			},
		});
		const before = await api().readOwnedImportAttempt(prisma, userIds[0], operationId);
		const token =
			kind === "omitted"
				? {}
				: { reconcileToken: kind === "wrong" ? "prior-worker" : "current-worker" };
		const accepted =
			action === "command"
				? await observe(operationId, "completed", token)
				: await verifyFiles(operationId, [versionedFingerprint("file-a")], token);
		expect(accepted).toBe(false);
		expect(await api().readOwnedImportAttempt(prisma, userIds[0], operationId)).toEqual(before);
	});
	it("lets only the current unexpired reconciliation worker preserve positive progress", async () => {
		const operationId = await created();
		await submit(operationId);
		await observe(operationId, "pending");
		await prisma.arrImportOperation.updateMany({
			where: { id: operationId, userId: userIds[0] },
			data: { reconcileToken: "current-worker", reconcileExpiresAt: new Date(Date.now() + 60_000) },
		});
		expect(await observe(operationId, "completed", { reconcileToken: "current-worker" })).toBe(
			true,
		);
		expect(
			await verifyFiles(operationId, [versionedFingerprint("file-a")], {
				reconcileToken: "current-worker",
			}),
		).toBe(true);
		expect(await api().readOwnedImportAttempt(prisma, userIds[0], operationId)).toMatchObject({
			state: "completed",
			verifiedFileCount: 1,
			reconcileToken: "current-worker",
		});
	});
});
