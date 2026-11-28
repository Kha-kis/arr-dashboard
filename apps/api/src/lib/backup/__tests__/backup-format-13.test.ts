import { execFileSync } from "node:child_process";
import { mkdtempSync, readFileSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join, resolve } from "node:path";
import { afterAll, beforeAll, describe, expect, it } from "vitest";
import { createTestPrismaClient } from "../../__tests__/test-prisma.js";
import { exportDatabase } from "../backup-database.js";
import { BACKUP_MODEL_DISPOSITIONS, ENCRYPTED_BACKUP_FIELDS } from "../backup-portability.js";
import { normalizeBackupForRestore, validateBackup } from "../backup-validation.js";

const SAFETY_FIELDS = [
	"arrImportOperations",
	"arrImportFileProofs",
	"arrImportSourceClaims",
	"queueCleanerImportReceipts",
	"quiActionClaims",
	"quiActionLogs",
	"labelSyncMutationAttempts",
] as const;
const V12_FIELDS = [
	"oidcProviders",
	"systemSettings",
	"trashTemplates",
	"trashSettings",
	"trashSyncSchedules",
	"templateQualityProfileMappings",
	"instanceQualityProfileOverrides",
	"standaloneCFDeployments",
	"qualitySizeMappings",
	"trashSyncHistory",
	"templateDeploymentHistory",
	"trashBackups",
	"huntConfigs",
	"huntLogs",
	"huntSearchHistory",
	"backupSettings",
	"vapidKeys",
	"notificationChannel",
	"notificationSubscription",
	"notificationRule",
	"notificationAggregationConfig",
	"autoTagRule",
	"labelSyncRule",
	"queueCleanerConfig",
	"libraryCleanupConfig",
	"libraryCleanupRule",
	"librarySyncSettings",
	"namingConfig",
	"userCustomFormat",
	"namingDeployHistory",
	"libraryCleanupApproval",
	"libraryCleanupMediaServerScan",
] as const;
const timestamp = "2026-10-01T12:00:00.000Z";
const downloadKey = "a".repeat(64);
const fingerprint = `v1:${"b".repeat(64)}`;
const hash = "c".repeat(40);
type Row = Record<string, unknown>;
type Payload = Record<string, Row[]>;

function operation(overrides: Row = {}): Row {
	return {
		id: "operation-1",
		userId: "owner-1",
		instanceId: "arr-1",
		originalInstanceId: "arr-1",
		connectionFingerprint: "d".repeat(64),
		service: "RADARR",
		origin: "queue-cleaner",
		mode: "Move",
		idempotencyKey: "intent-1",
		requestFingerprint: fingerprint,
		commandFingerprint: fingerprint,
		encryptedSources: "synthetic-ciphertext",
		sourcesEncryptionIv: "synthetic-iv",
		legacyReceiptId: "receipt-1",
		state: "unknown",
		reason: "evidence-unavailable",
		commandId: 42,
		commandState: "unknown",
		commandTerminal: false,
		selectedFileCount: 1,
		verifiedFileCount: 0,
		preparationExpiresAt: timestamp,
		submissionStartedAt: timestamp,
		lastCheckedAt: timestamp,
		nextCheckAt: timestamp,
		reconcileToken: null,
		reconcileExpiresAt: null,
		reconcileCursor: null,
		revision: 1,
		createdAt: timestamp,
		updatedAt: timestamp,
		...overrides,
	};
}
function coherentData(): Payload {
	return {
		...Object.fromEntries([...V12_FIELDS, ...SAFETY_FIELDS].map((field) => [field, []])),
		users: [
			{ id: "owner-1", username: "synthetic-owner", createdAt: timestamp, updatedAt: timestamp },
		],
		sessions: [],
		serviceTags: [],
		serviceInstanceTags: [],
		oidcAccounts: [],
		webAuthnCredentials: [],
		serviceInstances: [
			{
				id: "arr-1",
				userId: "owner-1",
				service: "RADARR",
				encryptedApiKey: "synthetic-key",
				encryptionIv: "synthetic-iv",
			},
			{
				id: "qui-1",
				userId: "owner-1",
				service: "QUI",
				encryptedApiKey: "synthetic-key",
				encryptionIv: "synthetic-iv",
			},
		],
		arrImportOperations: [operation()],
		arrImportFileProofs: [
			{
				id: "file-1",
				operationId: "operation-1",
				fileFingerprint: fingerprint,
				downloadKey,
				identityJson: { pathHash: "e".repeat(64), movieId: 7 },
				verifiedAt: null,
				createdAt: timestamp,
			},
		],
		arrImportSourceClaims: [
			{
				id: "source-1",
				userId: "owner-1",
				downloadKey,
				activeOperationId: "operation-1",
				createdAt: timestamp,
				updatedAt: timestamp,
			},
		],
		queueCleanerImportReceipts: [
			{
				id: "receipt-1",
				instanceId: "arr-1",
				downloadKey,
				queueId: 7,
				downloadTitle: "synthetic-title",
				connectionFingerprint: "d".repeat(64),
				commandFingerprint: fingerprint,
				commandId: 42,
				state: "unknown",
				lastAttemptAt: timestamp,
				createdAt: timestamp,
				updatedAt: timestamp,
			},
		],
		quiActionClaims: [
			{
				userId: "owner-1",
				serviceInstanceId: "qui-1",
				qbitInstanceId: 1,
				torrentHash: hash,
				attemptId: "attempt-1",
				createdAt: timestamp,
			},
		],
		quiActionLogs: [
			{
				id: "log-1",
				userId: "owner-1",
				serviceInstanceId: "qui-1",
				qbitInstanceId: 1,
				torrentHash: hash,
				attemptId: "attempt-1",
				action: "pause",
				payload: null,
				status: "uncertain",
				error: null,
				requestedAt: timestamp,
				completedAt: null,
			},
		],
	};
}
function backup(data = coherentData(), version = "1.3") {
	return {
		version,
		appVersion: "2.24.2",
		timestamp,
		data,
		secrets: { encryptionKey: "synthetic-key", sessionCookieSecret: "synthetic-cookie" },
	};
}
function first(data: Payload, field: string): Row {
	const row = data[field]?.[0];
	if (!row) throw new Error("Expected synthetic safety row");
	return row;
}
function detachedData(): Payload {
	const data = coherentData();
	data.arrImportOperations = [
		operation({
			instanceId: null,
			commandTerminal: true,
			commandState: "completed",
			state: "completed",
			verifiedFileCount: 1,
			nextCheckAt: null,
			reason: null,
		}),
	];
	first(data, "arrImportFileProofs").verifiedAt = timestamp;
	data.arrImportSourceClaims = [];
	data.queueCleanerImportReceipts = [];
	data.serviceInstances = data.serviceInstances?.filter((row) => row.id !== "arr-1") ?? [];
	return data;
}
function retainedCursor(): Row {
	return {
		version: 2,
		commandFingerprint: fingerprint,
		commandId: 42,
		commandEndedAt: timestamp,
		sourceIndex: 1,
		page: 1,
		pageSize: null,
		totalRecords: null,
		seenRecords: 0,
		witnesses: [],
		ambiguousFiles: [],
		retainedWitnesses: [{ fileFingerprint: fingerprint, fileId: 33, episodeIds: [] }],
		retainedAmbiguousFiles: [],
	};
}
const schemaSource = readFileSync(
	resolve(import.meta.dirname, "../../../../prisma/schema.prisma"),
	"utf8",
);
const schemaModels = new Map(
	[...schemaSource.matchAll(/^model (\w+) \{([\s\S]*?)^\}/gm)].map((match) => [
		match[1] as string,
		match[2] as string,
	]),
);

describe("backup portable schema inventory", () => {
	it("preserves destination runtime evidence, never imported worker leases", () => {
		const preserved = Object.entries(BACKUP_MODEL_DISPOSITIONS)
			.filter(([, entry]) => Reflect.get(entry, "preserveOnRestore") === true)
			.map(([model]) => model);
		expect(preserved).toEqual(["RestoreRuntimeControl", "SqliteRestoreStorageBinding"]);
		expect(Reflect.get(BACKUP_MODEL_DISPOSITIONS, "RestoreRuntimeControl")).toMatchObject({
			disposition: "installation-local",
			preserveOnRestore: true,
		});
		expect(Reflect.get(BACKUP_MODEL_DISPOSITIONS, "SqliteRestoreStorageBinding")).toMatchObject({
			disposition: "installation-local",
			preserveOnRestore: true,
		});
	});
	it("requires an explicit model disposition for every actual schema model", () => {
		expect(Object.keys(BACKUP_MODEL_DISPOSITIONS).sort()).toEqual([...schemaModels.keys()].sort());
		for (const entry of Object.values(BACKUP_MODEL_DISPOSITIONS)) {
			expect(["portable", "disposable", "installation-local"]).toContain(entry.disposition);
			expect(entry.reason.length).toBeGreaterThan(0);
			if (entry.disposition === "portable")
				expect({
					...coherentData(),
					searchGrabAttempts: [],
					searchGrabClaims: [],
					notificationOutboxEvents: [],
					notificationOutboxDeliveries: [],
				}).toHaveProperty(entry.payloadField ?? "missing");
		}
	});
	it("never makes qUI observation publication or rows portable authority", () => {
		for (const name of ["QuiObservationPublication", "QuiTorrentObservation"] as const) {
			expect(BACKUP_MODEL_DISPOSITIONS[name].disposition).toBe("disposable");
			expect(BACKUP_MODEL_DISPOSITIONS[name]).not.toHaveProperty("payloadField");
			expect(BACKUP_MODEL_DISPOSITIONS[name]).not.toHaveProperty("preserveOnRestore");
		}
	});
	it("covers every actual encrypted schema field with its typed IV and requiredness", () => {
		const encryptedFields = [...schemaModels].flatMap(([model, body]) =>
			[...body.matchAll(/^\s+(encrypted\w+)\s+(String\??)\s/gm)].map(
				(match) => `${model}.${match[1]}`,
			),
		);
		expect(
			ENCRYPTED_BACKUP_FIELDS.map((pair) => `${pair.model}.${pair.valueField}`).sort(),
		).toEqual(encryptedFields.sort());
		expect(ENCRYPTED_BACKUP_FIELDS).toHaveLength(encryptedFields.length);
		for (const pair of ENCRYPTED_BACKUP_FIELDS) {
			const body = schemaModels.get(pair.model) ?? "";
			for (const field of [pair.valueField, pair.ivField]) {
				const match = body.match(new RegExp(`^\\s+${field}\\s+(String\\??)\\s`, "m"));
				expect(match, `${pair.model}.${field}`).not.toBeNull();
				expect(match?.[1] === "String").toBe(pair.required);
			}
			expect(BACKUP_MODEL_DISPOSITIONS[pair.model].payloadField).toBe(pair.payloadField);
		}
	});
	it("rejects missing persisted scalar fields on the six mandatory safety row types", () => {
		for (const [model, field] of [
			["ArrImportOperation", "arrImportOperations"],
			["ArrImportFileProof", "arrImportFileProofs"],
			["ArrImportSourceClaim", "arrImportSourceClaims"],
			["QueueCleanerImportReceipt", "queueCleanerImportReceipts"],
			["QuiActionClaim", "quiActionClaims"],
			["QuiActionLog", "quiActionLogs"],
		]) {
			const body = schemaModels.get(model ?? "") ?? "";
			for (const match of body.matchAll(
				/^\s+(\w+)\s+(?:String|Int|Boolean|DateTime|Json|ServiceType)\??\s/gm,
			)) {
				const data = coherentData();
				delete first(data, field ?? "")[match[1] ?? ""];
				expect(() => validateBackup(backup(data)), `${model}.${match[1]}`).toThrow(
					/portable safety/i,
				);
			}
		}
	});
});

describe("backup format 1.3 safety coverage", () => {
	it("accepts a complete coherent portable snapshot", () => {
		expect(() => validateBackup(backup())).not.toThrow();
	});
	it.each([
		["SONARR", { pathHash: "e".repeat(64), seriesId: 7, episodeIds: [8], episodeFileId: 0 }],
		["RADARR", { pathHash: "e".repeat(64), movieId: 7, movieFileId: 0 }],
		[
			"LIDARR",
			{ pathHash: "e".repeat(64), artistId: 7, albumId: 8, trackFileId: 0, albumReleaseId: 0 },
		],
		["READARR", { pathHash: "e".repeat(64), authorId: 7, bookId: 8, bookFileId: 0 }],
	])("preserves schema-valid zero optional file coordinates for %s", (service, identity) => {
		const data = coherentData();
		first(data, "arrImportOperations").service = service;
		first(data, "serviceInstances").service = service;
		first(data, "arrImportFileProofs").identityJson = identity;
		expect(() => validateBackup(backup(data))).not.toThrow();
	});
	it.each([
		["SONARR", { pathHash: "e".repeat(64), seriesId: 7, episodeIds: [8], episodeFileId: -1 }],
		["RADARR", { pathHash: "e".repeat(64), movieId: 7, movieFileId: -1 }],
		["LIDARR", { pathHash: "e".repeat(64), artistId: 7, albumId: 8, trackFileId: -1 }],
		["LIDARR", { pathHash: "e".repeat(64), artistId: 7, albumId: 8, albumReleaseId: -1 }],
		["READARR", { pathHash: "e".repeat(64), authorId: 7, bookId: 8, bookFileId: -1 }],
	])("rejects negative optional file coordinates for %s", (service, identity) => {
		const data = coherentData();
		first(data, "arrImportOperations").service = service;
		first(data, "serviceInstances").service = service;
		first(data, "arrImportFileProofs").identityJson = identity;
		expect(() => validateBackup(backup(data))).toThrow(/portable safety/i);
	});
	it.each(SAFETY_FIELDS)("rejects omission of mandatory %s coverage", (field) => {
		const data = coherentData();
		delete data[field];
		expect(() => validateBackup(backup(data))).toThrow(new RegExp(field));
	});
	it.each(V12_FIELDS)("retains independent 1.2 strictness for %s", (field) => {
		const data = coherentData();
		delete data[field];
		expect(() => validateBackup(backup(data, "1.2"))).toThrow(new RegExp(field));
	});
	it.each(["1.0", "1.1", "1.2"])("does not fabricate %s safety coverage", (version) => {
		const data = coherentData();
		for (const field of SAFETY_FIELDS) delete data[field];
		const value = backup(data, version);
		expect(() => validateBackup(value)).not.toThrow();
		validateBackup(value);
		const normalized = normalizeBackupForRestore(value);
		for (const field of SAFETY_FIELDS) expect(normalized.data).not.toHaveProperty(field);
	});
	it.each([
		"arrImportOperations",
		"arrImportFileProofs",
		"arrImportSourceClaims",
		"queueCleanerImportReceipts",
		"quiActionClaims",
		"quiActionLogs",
	])("rejects duplicate %s identity", (field) => {
		const data = coherentData();
		data[field]?.push({ ...first(data, field) });
		expect(() => validateBackup(backup(data))).toThrow(/portable safety/i);
	});
	it.each([
		["arrImportOperations", "userId", "missing"],
		["arrImportOperations", "instanceId", "qui-1"],
		["arrImportOperations", "originalInstanceId", "other-arr"],
		["arrImportOperations", "legacyReceiptId", "missing"],
		["arrImportOperations", "commandId", 99],
		["arrImportFileProofs", "operationId", "missing"],
		["arrImportFileProofs", "fileFingerprint", "invalid"],
		["arrImportFileProofs", "identityJson", { pathHash: "e".repeat(64), seriesId: 7 }],
		["arrImportSourceClaims", "activeOperationId", "missing"],
		["arrImportSourceClaims", "userId", "missing"],
		["arrImportSourceClaims", "downloadKey", "f".repeat(64)],
		["queueCleanerImportReceipts", "instanceId", "missing"],
		["queueCleanerImportReceipts", "commandFingerprint", `v1:${"f".repeat(64)}`],
		["quiActionClaims", "attemptId", "other-attempt"],
		["quiActionClaims", "torrentHash", "f".repeat(40)],
		["quiActionClaims", "qbitInstanceId", 2],
		["quiActionLogs", "serviceInstanceId", "arr-1"],
		["quiActionLogs", "userId", "missing"],
		["quiActionLogs", "attemptId", "other-attempt"],
	] as const)("rejects mismatched %s.%s", (field, key, value) => {
		const data = coherentData();
		first(data, field)[key] = value;
		expect(() => validateBackup(backup(data))).toThrow(/portable safety/i);
	});
	it("requires all selected file proofs and positive verification counts", () => {
		const data = coherentData();
		first(data, "arrImportOperations").verifiedFileCount = 1;
		expect(() => validateBackup(backup(data))).toThrow(/portable safety/i);
		first(data, "arrImportOperations").verifiedFileCount = 0;
		data.arrImportFileProofs = [];
		expect(() => validateBackup(backup(data))).toThrow(/portable safety/i);
	});
	it("does not require a new claim for legacy unresolved qUI history", () => {
		const data = coherentData();
		first(data, "quiActionLogs").attemptId = null;
		data.quiActionClaims = [];
		expect(() => validateBackup(backup(data))).not.toThrow();
	});
	it("retains claims after audit settlement fails even if the linked log is terminal", () => {
		const data = coherentData();
		first(data, "quiActionLogs").status = "success";
		first(data, "quiActionLogs").completedAt = timestamp;
		expect(() => validateBackup(backup(data))).not.toThrow();
	});
	it("rejects an unresolved modern action without its durable hold", () => {
		const data = coherentData();
		data.quiActionClaims = [];
		expect(() => validateBackup(backup(data))).toThrow(/portable safety/i);
	});
	it("reports malformed rows without copying private record contents", () => {
		const data = coherentData();
		first(data, "arrImportOperations").userId = "private-canary";
		try {
			validateBackup(backup(data));
			throw new Error("Expected validation failure");
		} catch (error) {
			expect(String(error)).toMatch(/portable safety/i);
			expect(String(error)).not.toContain("private-canary");
		}
	});
	it("preserves explicitly detached terminal import history without rebinding it", () => {
		const value = backup(detachedData());
		expect(() => validateBackup(value)).not.toThrow();
		validateBackup(value);
		expect(value.data.arrImportOperations?.[0]).toMatchObject({
			instanceId: null,
			originalInstanceId: "arr-1",
			legacyReceiptId: "receipt-1",
		});
	});
	it.each([
		["commandTerminal", false],
		["commandId", null],
		["state", "unknown"],
		["verifiedFileCount", 0],
		["lastCheckedAt", null],
		["submissionStartedAt", null],
		["lastCheckedAt", "2026-09-30T12:00:00.000Z"],
		["reconcileToken", "active-worker"],
	])("rejects detached import history with incomplete terminal %s evidence", (field, value) => {
		const data = detachedData();
		first(data, "arrImportOperations")[field as string] = value;
		expect(() => validateBackup(backup(data))).toThrow(/portable safety/i);
	});
	it("rejects verification evidence newer than the recorded operation", () => {
		const data = detachedData();
		first(data, "arrImportFileProofs").verifiedAt = "2026-10-02T12:00:00.000Z";
		expect(() => validateBackup(backup(data))).toThrow(/portable safety/i);
	});
	it("rejects a cursor with a different immutable command binding", () => {
		const data = coherentData();
		first(data, "arrImportOperations").reconcileCursor = {
			version: 1,
			commandFingerprint: `v1:${"f".repeat(64)}`,
			commandId: 42,
			commandEndedAt: timestamp,
			sourceIndex: 0,
			page: 1,
			pageSize: null,
			totalRecords: null,
			seenRecords: 0,
			witnesses: [],
			ambiguousFiles: [],
		};
		expect(() => validateBackup(backup(data))).toThrow(/portable safety/i);
	});
	it("preserves valid retained cursor evidence on detached terminal history unchanged", () => {
		const data = detachedData();
		first(data, "arrImportOperations").reconcileCursor = retainedCursor();
		const before = structuredClone(data);
		expect(() => validateBackup(backup(data))).not.toThrow();
		expect(data).toEqual(before);
	});
	it.each([
		{ commandId: 99 },
		{ commandFingerprint: `v1:${"f".repeat(64)}` },
		{
			retainedWitnesses: [{ fileFingerprint: `v1:${"f".repeat(64)}`, fileId: 33, episodeIds: [] }],
		},
		{ page: -1 },
		{ commandEndedAt: "2026-09-30T12:00:00.000Z" },
	])("rejects malformed or mismatched retained cursor evidence %j", (change) => {
		const data = detachedData();
		first(data, "arrImportOperations").reconcileCursor = { ...retainedCursor(), ...change };
		expect(() => validateBackup(backup(data))).toThrow(/portable safety/i);
	});
	it("rejects paired ciphertext missing its IV without touching the record", () => {
		const data = coherentData();
		first(data, "serviceInstances").encryptionIv = null;
		expect(() => validateBackup(backup(data))).toThrow(/portable safety/i);
	});
});

describe("backup format 1.3 actual populated exporter", () => {
	let directory: string;
	let prisma: ReturnType<typeof createTestPrismaClient>;
	beforeAll(async () => {
		directory = mkdtempSync(join(tmpdir(), "backup-format13-"));
		const api = resolve(import.meta.dirname, "../../../..");
		const database = join(directory, "synthetic.db");
		// Run only the installed CLI from an empty temporary cwd: no dotenv,
		// package-manager config, client generation, or existing database target.
		execFileSync(
			process.execPath,
			[
				join(api, "node_modules/prisma/build/index.js"),
				"db",
				"push",
				"--schema",
				join(api, "prisma/schema.prisma"),
				"--url",
				`file:${database}`,
			],
			{
				cwd: directory,
				env: { PATH: process.env.PATH, DATABASE_URL: `file:${database}` },
				stdio: "pipe",
			},
		);
		prisma = createTestPrismaClient(database);
		await prisma.user.create({ data: { id: "owner-1", username: "synthetic-owner" } });
		for (const [id, service] of [
			["arr-1", "RADARR"],
			["qui-1", "QUI"],
		] as const) {
			await prisma.serviceInstance.create({
				data: {
					id,
					userId: "owner-1",
					service,
					label: "synthetic",
					baseUrl: "http://synthetic.invalid",
					encryptedApiKey: "synthetic-key",
					encryptionIv: "synthetic-iv",
				},
			});
		}
		const data = coherentData();
		await prisma.queueCleanerImportReceipt.create({
			data: first(data, "queueCleanerImportReceipts") as never,
		});
		await prisma.arrImportOperation.create({ data: operation() as never });
		await prisma.arrImportFileProof.create({ data: first(data, "arrImportFileProofs") as never });
		await prisma.arrImportSourceClaim.create({
			data: first(data, "arrImportSourceClaims") as never,
		});
		await prisma.quiActionClaim.create({ data: first(data, "quiActionClaims") as never });
		await prisma.quiActionClaim.create({
			data: {
				userId: "owner-1",
				serviceInstanceId: "qui-1",
				qbitInstanceId: 1,
				torrentHash: "f".repeat(40),
				attemptId: "terminal-attempt",
				createdAt: timestamp,
			},
		});
		await prisma.quiActionLog.createMany({
			data: [
				first(data, "quiActionLogs") as never,
				{
					id: "linked-terminal-log",
					userId: "owner-1",
					serviceInstanceId: "qui-1",
					qbitInstanceId: 1,
					torrentHash: "F".repeat(40),
					attemptId: "terminal-attempt",
					action: "pause",
					status: "success",
					requestedAt: timestamp,
					completedAt: timestamp,
				},
				...Array.from({ length: 3 }, (_, i) => ({
					id: `terminal-log-${i}`,
					userId: "owner-1",
					serviceInstanceId: "qui-1",
					qbitInstanceId: 1,
					torrentHash: String(i).repeat(40),
					action: "pause",
					status: "success",
					requestedAt: timestamp,
					completedAt: timestamp,
				})),
			],
		});
		await prisma.huntConfig.create({ data: { id: "hunt-1", instanceId: "arr-1" } });
		await prisma.huntLog.createMany({
			data: Array.from({ length: 3 }, (_, i) => ({
				id: `hunt-log-${i}`,
				instanceId: "arr-1",
				huntType: "missing",
				status: "completed",
				startedAt: timestamp,
			})),
		});
	}, 60_000);
	afterAll(async () => {
		await prisma?.$disconnect();
		if (directory) rmSync(directory, { recursive: true, force: true });
	});
	it.each([true, false])(
		"retains all mandatory safety evidence when history exclusion is %s",
		async (excludeOperationalHistory) => {
			const data = await exportDatabase(prisma, {
				excludeOperationalHistory,
				historyRetentionLimit: 1,
			});
			for (const field of SAFETY_FIELDS) expect(data).toHaveProperty(field);
			expect(data).toMatchObject({
				arrImportOperations: [expect.objectContaining({ id: "operation-1", commandId: 42 })],
				arrImportFileProofs: [expect.objectContaining({ operationId: "operation-1" })],
				arrImportSourceClaims: [expect.objectContaining({ activeOperationId: "operation-1" })],
				queueCleanerImportReceipts: [expect.objectContaining({ id: "receipt-1" })],
				quiActionClaims: expect.arrayContaining([
					expect.objectContaining({ attemptId: "attempt-1" }),
					expect.objectContaining({ attemptId: "terminal-attempt" }),
				]),
			});
			expect((data as Record<string, Row[]>).quiActionLogs?.map((row) => row.id).sort()).toEqual([
				"linked-terminal-log",
				"log-1",
			]);
			expect(data.huntLogs).toHaveLength(excludeOperationalHistory ? 0 : 1);
			expect(() => validateBackup(backup(JSON.parse(JSON.stringify(data))))).not.toThrow();
		},
	);
});
