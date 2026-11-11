import { constants } from "node:fs";
import { chmod, mkdtemp, open, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterEach, beforeEach, describe, expect, it } from "vitest";
import { Encryptor } from "../../auth/encryption.js";
import { createNotificationOutboxNativeFixture } from "../../notifications/__tests__/notification-outbox-native-fixture.js";
import { NotificationDispatcher } from "../../notifications/notification-dispatcher.js";
import { createNotificationOutboxRepository } from "../../notifications/outbox-repository.js";
import type { NotificationOutboxPolicy } from "../../notifications/outbox-types.js";
import { createNotificationOutboxWorker } from "../../notifications/outbox-worker.js";
import {
	decryptBackupData,
	type EncryptedBackupEnvelope,
	encryptBackupData,
} from "../backup-crypto.js";
import { exportDatabase, restoreDatabase, restorePreparedDatabase } from "../backup-database.js";
import {
	originalPreparedRestoreRecords,
	prepareRestoreData,
} from "../backup-restore-preparation.js";
import { BackupService } from "../backup-service.js";
import { validateBackup } from "../backup-validation.js";
import {
	getRestoreRuntimeClientContext,
	getRestoreRuntimeReplacementClientContext,
	withRestoreRuntimeReplacement,
} from "../restore-runtime-admission.js";
import { createRuntimeReplacementPrismaClient } from "../restore-runtime-client.js";
import { readRestoreRuntimeControl } from "../restore-runtime-repository.js";

type Fixture = Awaited<ReturnType<typeof createNotificationOutboxNativeFixture>>;
type SigningKeyRow = {
	id: number;
	publicKey: string;
	encryptedPrivateKey: string;
	privateKeyIv: string;
};
const fixtures: Fixture[] = [];
const signingKeyPreimages = new Map<Fixture, SigningKeyRow | null>();
afterEach(async () => {
	const failures: unknown[] = [];
	for (const fixture of fixtures.splice(0)) {
		try {
			await closeFixture(fixture);
		} catch (error) {
			failures.push(error);
		}
	}
	if (failures.length) throw new AggregateError(failures, "Synthetic fixture teardown failed");
});
async function boot() {
	const fixture = await createNotificationOutboxNativeFixture();
	try {
		const before = await fixture.run(() =>
			fixture.prisma.vapidKeys.findUnique({ where: { id: 1 } }),
		);
		if (before && !authenticatesSigningKey(before, fixture.encryptor))
			throw new Error("Unproved synthetic signing-key baseline");
		signingKeyPreimages.set(fixture, before);
	} catch (error) {
		await fixture.close();
		throw error;
	}
	fixtures.push(fixture);
	return fixture;
}

async function restoreSigningKeyPreimage(fixture: Fixture, before: SigningKeyRow | null) {
	if (before && (before.id !== 1 || !authenticatesSigningKey(before, fixture.encryptor)))
		throw new Error("Unproved synthetic signing-key baseline");
	await fixture.run(() =>
		fixture.prisma.$transaction(
			async (tx) => {
				const current = await tx.vapidKeys.findUnique({ where: { id: 1 } });
				if (sameSigningKey(current, before)) return;
				if (
					current &&
					((before && current.publicKey !== before.publicKey) ||
						(!authenticatesSigningKey(current, fixture.encryptor) &&
							!authenticatesSigningKey(current, new Encryptor("a".repeat(64)))))
				)
					throw new Error("Unproved synthetic signing-key state");
				if (current) {
					// Compare every observed field so a changed row is never overwritten/deleted.
					const result = before
						? await tx.vapidKeys.updateMany({ where: current, data: before })
						: await tx.vapidKeys.deleteMany({ where: current });
					if (result.count !== 1) throw new Error("Synthetic signing-key correction fence lost");
				} else if (before) await tx.vapidKeys.create({ data: before });
				if (!sameSigningKey(await tx.vapidKeys.findUnique({ where: { id: 1 } }), before))
					throw new Error("Synthetic signing-key preimage was not conserved");
			},
			{ isolationLevel: "Serializable" },
		),
	);
}

function sameSigningKey(left: SigningKeyRow | null, right: SigningKeyRow | null): boolean {
	if (!left || !right) return left === right;
	return (
		left.id === right.id &&
		left.publicKey === right.publicKey &&
		left.encryptedPrivateKey === right.encryptedPrivateKey &&
		left.privateKeyIv === right.privateKeyIv
	);
}

function authenticatesSigningKey(row: SigningKeyRow, encryptor: Encryptor): boolean {
	try {
		encryptor.decrypt({ value: row.encryptedPrivateKey, iv: row.privateKeyIv });
		return true;
	} catch {
		return false;
	}
}

async function closeFixture(fixture: Fixture) {
	const index = fixtures.indexOf(fixture);
	if (index >= 0) fixtures.splice(index, 1);
	const failures: unknown[] = [];
	try {
		if (!signingKeyPreimages.has(fixture))
			throw new Error("Missing synthetic signing-key preimage");
		await restoreSigningKeyPreimage(fixture, signingKeyPreimages.get(fixture)!);
	} catch (error) {
		failures.push(error);
	}
	try {
		await fixture.close();
	} catch (error) {
		failures.push(error);
	} finally {
		signingKeyPreimages.delete(fixture);
	}
	if (failures.length === 1) throw failures[0];
	if (failures.length) throw new AggregateError(failures, "Synthetic fixture teardown failed");
}

async function signingKey(fixture: Fixture): Promise<SigningKeyRow> {
	return fixture.run(async () => {
		const existing = await fixture.prisma.vapidKeys.findUnique({ where: { id: 1 } });
		if (existing) return existing;
		const encrypted = fixture.encryptor.encrypt("synthetic-signing-key");
		return fixture.prisma.vapidKeys.create({
			data: {
				id: 1,
				publicKey: "synthetic-public-key",
				encryptedPrivateKey: encrypted.value,
				privateKeyIv: encrypted.iv,
			},
		});
	});
}

describe("synthetic signing-key fixture conservation", () => {
	it("restores the exact pre-existing bytes after a cross-key replacement", async () => {
		const fixture = await boot();
		const before = await signingKey(fixture);
		const translated = new Encryptor("a".repeat(64)).encrypt("synthetic-signing-key");
		await fixture.run(() =>
			fixture.prisma.vapidKeys.update({
				where: { id: 1 },
				data: { encryptedPrivateKey: translated.value, privateKeyIv: translated.iv },
			}),
		);
		await restoreSigningKeyPreimage(fixture, before);
		expect(
			await fixture.run(() => fixture.prisma.vapidKeys.findUnique({ where: { id: 1 } })),
		).toEqual(before);
	});
	it("conserves prior absence without inventing an installation key", async () => {
		const fixture = await boot();
		await fixture.run(() => fixture.prisma.vapidKeys.deleteMany({ where: { id: 1 } }));
		await signingKey(fixture);
		await restoreSigningKeyPreimage(fixture, null);
		expect(
			await fixture.run(() => fixture.prisma.vapidKeys.findUnique({ where: { id: 1 } })),
		).toBeNull();
	});
	it("refuses a changed public identity without overwriting it", async () => {
		const fixture = await boot();
		const before = await signingKey(fixture);
		const foreign = { ...before, publicKey: "synthetic-other-public-key" };
		await fixture.run(() => fixture.prisma.vapidKeys.update({ where: { id: 1 }, data: foreign }));
		try {
			await expect(restoreSigningKeyPreimage(fixture, before)).rejects.toThrow(
				"Unproved synthetic signing-key state",
			);
			expect(
				await fixture.run(() => fixture.prisma.vapidKeys.findUnique({ where: { id: 1 } })),
			).toEqual(foreign);
		} finally {
			await fixture.run(() => fixture.prisma.vapidKeys.update({ where: { id: 1 }, data: before }));
		}
	});
	it("does not alter an unrelated signing-key row", async () => {
		const fixture = await boot();
		const before = await signingKey(fixture);
		const encrypted = fixture.encryptor.encrypt("synthetic-unrelated-key");
		const unrelated = {
			id: 2,
			publicKey: "synthetic-unrelated-public-key",
			encryptedPrivateKey: encrypted.value,
			privateKeyIv: encrypted.iv,
		};
		await fixture.run(() => fixture.prisma.vapidKeys.create({ data: unrelated }));
		try {
			const translated = new Encryptor("a".repeat(64)).encrypt("synthetic-signing-key");
			await fixture.run(() =>
				fixture.prisma.vapidKeys.update({
					where: { id: 1 },
					data: { encryptedPrivateKey: translated.value, privateKeyIv: translated.iv },
				}),
			);
			await restoreSigningKeyPreimage(fixture, before);
			expect(
				await fixture.run(() => fixture.prisma.vapidKeys.findUnique({ where: { id: 1 } })),
			).toEqual(before);
			expect(
				await fixture.run(() => fixture.prisma.vapidKeys.findUnique({ where: { id: 2 } })),
			).toEqual(unrelated);
		} finally {
			await fixture.run(() => fixture.prisma.vapidKeys.deleteMany({ where: unrelated }));
		}
	});
	it("closes the native fixture even when an unfamiliar key makes cleanup refuse", async () => {
		const fixture = await boot();
		const original = signingKeyPreimages.get(fixture)!;
		const before = await signingKey(fixture);
		const encrypted = new Encryptor("b".repeat(64)).encrypt("synthetic-unrecognized-key");
		const unrecognized = {
			...before,
			encryptedPrivateKey: encrypted.value,
			privateKeyIv: encrypted.iv,
		};
		await fixture.run(() =>
			fixture.prisma.vapidKeys.update({ where: { id: 1 }, data: unrecognized }),
		);
		try {
			await expect(closeFixture(fixture)).rejects.toThrow("Unproved synthetic signing-key state");
			expect(() => getRestoreRuntimeClientContext(fixture.runtime)).toThrow();
		} finally {
			// Only PG shares the just-owned synthetic database across cases. Repair
			// this test's exact rejected row after closure, never an unproved replacement.
			if (fixture.engine === "postgresql") {
				const repair = await createNotificationOutboxNativeFixture();
				try {
					await repair.run(async () => {
						expect(await repair.prisma.vapidKeys.findUnique({ where: { id: 1 } })).toEqual(
							unrecognized,
						);
						const result = original
							? await repair.prisma.vapidKeys.updateMany({ where: unrecognized, data: original })
							: await repair.prisma.vapidKeys.deleteMany({ where: unrecognized });
						expect(result.count).toBe(1);
					});
				} finally {
					await repair.close();
				}
			}
		}
	});
});

type ExportedData = Awaited<ReturnType<typeof exportDatabase>>;
function backup(data: ExportedData, version = "1.5") {
	return {
		version,
		appVersion: "synthetic-test",
		timestamp: "2026-10-10T12:00:00.000Z",
		data,
		secrets: { encryptionKey: "9".repeat(64), sessionCookieSecret: "synthetic-cookie-secret" },
	};
}

async function prepare(
	data: ExportedData,
	destination = new Encryptor("a".repeat(64)),
	installationId = "synthetic-other-destination",
	version = "1.5",
) {
	return prepareRestoreData({
		envelope: await encryptBackupData(JSON.stringify(backup(data, version)), "synthetic-password"),
		password: "synthetic-password",
		destination: {
			encryptor: destination,
			installationId,
			stableForRestart: true,
		},
	});
}

const nativeDestination = "synthetic-notification-outbox-destination";
async function nativeSnapshot(fixture: Fixture) {
	return {
		users: await fixture.prisma.user.findMany({ orderBy: { id: "asc" } }),
		channels: await fixture.prisma.notificationChannel.findMany({ orderBy: { id: "asc" } }),
		events: await fixture.prisma.notificationOutboxEvent.findMany({ orderBy: { id: "asc" } }),
		deliveries: await fixture.prisma.notificationOutboxDelivery.findMany({
			orderBy: { id: "asc" },
		}),
		logs: await fixture.prisma.notificationLog.findMany({ orderBy: { id: "asc" } }),
	};
}

/** Generate state with actual admission/grouping/claim/outcome transactions, not forged rows. */
async function completeGraph(fixture: Fixture) {
	const repository = fixture.repository();
	const admit = (title: string, policy: NotificationOutboxPolicy = { stage: "ready" }) =>
		repository.admit({ ...fixture.input(), payload: { ...fixture.payload, title }, policy });
	await admit("Synthetic ready");
	await admit("Synthetic deferred", {
		stage: "deferred",
		dueAt: new Date(fixture.now.getTime() + 90_000),
	});
	await admit("Synthetic aggregating", {
		stage: "aggregating",
		windowSeconds: 60,
		maxBatchSize: 10,
	});
	for (const state of ["retry-waiting", "submitting", "sent", "rejected", "uncertain"] as const) {
		const { eventId } = await admit(`Synthetic ${state}`);
		const delivery = await fixture.prisma.notificationOutboxDelivery.findFirstOrThrow({
			where: { eventId, userId: fixture.userId },
		});
		const attempt = await repository.beginAttempt(delivery.id);
		expect(attempt).not.toBeNull();
		if (!attempt) throw new Error("Synthetic actual marker missing");
		if (state !== "submitting") {
			const outcome =
				state === "uncertain"
					? { outcome: "uncertain" as const }
					: {
							success: state === "sent",
							retryable: state === "retry-waiting",
							...(state === "sent" ? {} : { failureCategory: "provider-unavailable" as const }),
						};
			expect(await repository.finishAttempt(attempt, outcome)).toBe(true);
		}
	}
	const canceled = await admit("Synthetic canceled");
	await fixture.prisma.notificationChannel.update({
		where: { id: fixture.channelId },
		data: { enabled: false },
	});
	const canceledDelivery = await fixture.prisma.notificationOutboxDelivery.findFirstOrThrow({
		where: { eventId: canceled.eventId, userId: fixture.userId },
	});
	expect(await repository.beginAttempt(canceledDelivery.id)).toBeNull();
	await fixture.prisma.notificationChannel.update({
		where: { id: fixture.channelId },
		data: { enabled: true },
	});
	for (const title of ["Synthetic member one", "Synthetic member two"])
		await admit(title, { stage: "aggregating", windowSeconds: 60, maxBatchSize: 2 });
	expect(await repository.groupDue()).toHaveLength(1);
	const data = await exportDatabase(fixture.prisma, {
		excludeOperationalHistory: true,
		historyRetentionLimit: 1,
	});
	expect(data.notificationOutboxEvents).toHaveLength(12);
	expect(data.notificationOutboxDeliveries).toHaveLength(12);
	expect(data.notificationOutboxDeliveries.map((row) => row.state).sort()).toEqual([
		"canceled",
		"canceled",
		"canceled",
		"ready",
		"ready",
		"rejected",
		"retry-waiting",
		"sent",
		"submitting",
		"uncertain",
		"waiting",
		"waiting",
	]);
	return data;
}

describe("notification backup on actual owned native storage", () => {
	it("writes an actual encrypted 1.6 scheduled backup with the full native notification graph", async () => {
		const fixture = await boot();
		const directory = await mkdtemp(join(tmpdir(), "arr-outbox-backup-writer-"));
		await chmod(directory, 0o700);
		const secretsPath = join(directory, "secrets.json");
		await writeFile(
			secretsPath,
			JSON.stringify({
				encryptionKey: "9".repeat(64),
				sessionCookieSecret: "synthetic-cookie-secret",
			}),
			{ mode: 0o600, flag: "wx" },
		);
		const password = fixture.encryptor.encrypt("synthetic-backup-writer-password");
		await fixture.run(async () => {
			await completeGraph(fixture);
			await fixture.prisma.backupSettings.create({
				data: { id: 1, encryptedPassword: password.value, passwordIv: password.iv },
			});
		});
		try {
			await fixture.run(async () => {
				const before = await nativeSnapshot(fixture);
				const service = new BackupService(fixture.prisma, secretsPath, fixture.encryptor);
				const info = await service.createBackup("synthetic-test", "scheduled", {
					historyRetentionLimit: 1,
				});
				const file = join(directory, "backups", "scheduled", info.filename);
				const handle = await open(
					file,
					constants.O_RDONLY | constants.O_NOFOLLOW | constants.O_NONBLOCK,
				);
				let envelope: EncryptedBackupEnvelope;
				try {
					const fileStat = await handle.stat();
					if (!fileStat.isFile()) throw new Error("Expected a regular synthetic backup file");
					expect(fileStat.mode & 0o777).toBe(0o600);
					expect(info.size).toBe(fileStat.size);
					envelope = JSON.parse(await handle.readFile("utf8")) as EncryptedBackupEnvelope;
				} finally {
					await handle.close();
				}
				expect(envelope.version).toBe("1.0");
				const payload: unknown = JSON.parse(
					await decryptBackupData(envelope, "synthetic-backup-writer-password"),
				);
				validateBackup(payload);
				expect(payload.version).toBe("1.6");
				const sorted = (rows: unknown[] | undefined) =>
					rows
						?.slice()
						.sort((a, b) =>
							String((a as Record<string, unknown>).id).localeCompare(
								String((b as Record<string, unknown>).id),
							),
						);
				expect(sorted(payload.data.notificationOutboxEvents)).toEqual(
					JSON.parse(JSON.stringify(before.events)),
				);
				expect(sorted(payload.data.notificationOutboxDeliveries)).toEqual(
					JSON.parse(JSON.stringify(before.deliveries)),
				);
				const prepared = await prepareRestoreData({
					envelope,
					password: "synthetic-backup-writer-password",
					destination: {
						encryptor: new Encryptor("a".repeat(64)),
						installationId: "synthetic-other-destination",
						stableForRestart: true,
					},
				});
				expect(prepared.notificationOutboxCoverage).toBe("complete");
				expect(prepared.grabSafetyCoverage).toBe("complete");
				expect(prepared.safetyCoverage).toBe("complete");
				expect(await nativeSnapshot(fixture)).toEqual(before);
			});
		} finally {
			await fixture.run(() =>
				fixture.prisma.backupSettings.deleteMany({
					where: { id: 1, encryptedPassword: password.value, passwordIv: password.iv },
				}),
			);
		}
	}, 30_000);

	it("authenticates complete format1.6 native evidence and reports explicit notification coverage", async () => {
		const fixture = await boot();
		await fixture.run(async () => {
			await fixture.repository().admit(fixture.input());
			const data = await exportDatabase(fixture.prisma, { excludeOperationalHistory: true });
			expect(() => validateBackup(backup(data, "1.6"))).not.toThrow();
			const prepared = await prepare(data, fixture.encryptor, nativeDestination, "1.6");
			expect(prepared).toMatchObject({
				formatVersion: "1.6",
				safetyCoverage: "complete",
				grabSafetyCoverage: "complete",
				notificationOutboxCoverage: "complete",
			});
			await restorePreparedDatabase(fixture.prisma, prepared, nativeDestination);
			expect((await nativeSnapshot(fixture)).deliveries).toEqual([
				expect.objectContaining({ state: "canceled", outcomeCategory: "restored-not-replayed" }),
			]);
		});
	});

	it("format1.6 recognizes explicit empty notification collections as observed coverage", async () => {
		const fixture = await boot();
		await fixture.run(async () => {
			const data = await exportDatabase(fixture.prisma, { excludeOperationalHistory: true });
			const prepared = await prepare(data, fixture.encryptor, nativeDestination, "1.6");
			expect(prepared).toMatchObject({
				notificationOutboxCoverage: "complete",
				records: { notificationOutboxEvents: [], notificationOutboxDeliveries: [] },
			});
		});
	});

	it.each(["notificationOutboxEvents", "notificationOutboxDeliveries"] as const)(
		"format1.6 requires explicit %s even when current work is empty",
		async (field) => {
			const fixture = await boot();
			await fixture.run(async () => {
				const data = await exportDatabase(fixture.prisma, { excludeOperationalHistory: true });
				delete (data as Record<string, unknown>)[field];
				expect(() => validateBackup(backup(data, "1.6"))).toThrow(new RegExp(field));
			});
		},
	);

	it.each(["1.3", "1.4", "1.5"] as const)(
		"retains historical %s safety coverage without inventing notification completeness",
		async (version) => {
			const fixture = await boot();
			await fixture.run(async () => {
				const data = await exportDatabase(fixture.prisma, { excludeOperationalHistory: true });
				delete (data as Record<string, unknown>).notificationOutboxEvents;
				delete (data as Record<string, unknown>).notificationOutboxDeliveries;
				const prepared = await prepare(data, fixture.encryptor, nativeDestination, version);
				expect(prepared).toMatchObject({
					formatVersion: version,
					safetyCoverage: "complete",
					grabSafetyCoverage: version === "1.5" ? "complete" : "legacy-incomplete",
					notificationOutboxCoverage: "legacy-incomplete",
				});
				expect(prepared.records.notificationOutboxEvents).toBeUndefined();
				expect(prepared.records.notificationOutboxDeliveries).toBeUndefined();
			});
		},
	);

	it("accepts an elapsed genuine single-member digest with sealed exact lineage", async () => {
		const fixture = await boot();
		await fixture.run(async () => {
			await fixture.repository().admit({
				...fixture.input(),
				policy: { stage: "aggregating", windowSeconds: 60, maxBatchSize: 10 },
			});
			fixture.now = new Date(fixture.now.getTime() + 60000);
			expect(await fixture.repository().groupDue()).toHaveLength(1);
			const data = await exportDatabase(fixture.prisma, { excludeOperationalHistory: true });
			expect(data.notificationOutboxEvents).toHaveLength(2);
			await expect(prepare(data)).resolves.toBeDefined();
		});
	});
	it.each([
		"swapped-parent",
		"missing-member",
		"missing-all-members",
		"digest-count",
		"digest-item",
		"member-policy",
	] as const)(
		"authenticates aggregation lineage instead of accepting %s",
		async (category) => {
			const fixture = await boot();
			await fixture.run(async () => {
				const repository = fixture.repository();
				for (const titles of [
					["Synthetic alpha one", "Synthetic alpha two"],
					["Synthetic beta one", "Synthetic beta two"],
				]) {
					for (const title of titles)
						await repository.admit({
							...fixture.input(),
							payload: { ...fixture.payload, title },
							policy: { stage: "aggregating", windowSeconds: 60, maxBatchSize: 2 },
						});
					expect(await repository.groupDue()).toHaveLength(1);
				}
				const data = await exportDatabase(fixture.prisma, { excludeOperationalHistory: true });
				expect(data.notificationOutboxEvents).toHaveLength(6);
				expect(data.notificationOutboxDeliveries).toHaveLength(6);
				await expect(prepare(data)).resolves.toBeDefined();
				const members = data.notificationOutboxEvents.filter((row) => row.stage === "grouped");
				const member = members[0]!;
				const parent = data.notificationOutboxEvents.find(
					(row) => row.id === member.aggregateParentId,
				)!;
				if (category === "swapped-parent")
					member.aggregateParentId = data.notificationOutboxEvents.find(
						(row) => row.stage === "ready" && row.id !== parent.id,
					)!.id;
				else if (category === "missing-member" || category === "missing-all-members") {
					const removed = new Set(
						members
							.filter((row) =>
								category === "missing-member"
									? row.id === member.id
									: row.aggregateParentId === parent.id,
							)
							.map((row) => row.id),
					);
					data.notificationOutboxEvents = data.notificationOutboxEvents.filter(
						(row) => !removed.has(row.id),
					);
					data.notificationOutboxDeliveries = data.notificationOutboxDeliveries.filter(
						(row) => !removed.has(row.eventId),
					);
				} else {
					const row = category === "member-policy" ? member : parent;
					const envelope = JSON.parse(
						fixture.encryptor.decrypt({ value: row.encryptedPayload, iv: row.payloadIv }),
					);
					if (category === "digest-count") envelope.payload.metadata.count = 99;
					else if (category === "digest-item")
						envelope.payload.metadata.items[0].body = "Synthetic altered digest item";
					else {
						envelope.policy.windowSeconds = 120;
						envelope.dueAt = new Date(
							new Date(envelope.acceptedAt).getTime() + 120000,
						).toISOString();
						row.dueAt = new Date(envelope.dueAt);
						row.aggregationWindowSeconds = 120;
						row.scopeFingerprint = fixture.encryptor.fingerprint(
							JSON.stringify([
								"notification-scope",
								1,
								row.userId,
								[
									envelope.payload.eventType,
									envelope.recipients,
									envelope.fallbackEventTypes,
									envelope.policy,
								],
							]),
						);
					}
					const changed = fixture.encryptor.encrypt(JSON.stringify(envelope));
					row.encryptedPayload = changed.value;
					row.payloadIv = changed.iv;
				}
				await expect(prepare(data)).rejects.toThrow();
			});
		},
		30000,
	);

	it.each(["missing", "empty"] as const)(
		"native replacement refuses legacy %s erasure of actual uncertain evidence",
		async (families) => {
			const fixture = await boot();
			await fixture.run(async () => {
				const repository = fixture.repository();
				const { eventId } = await repository.admit(fixture.input());
				const delivery = await fixture.prisma.notificationOutboxDelivery.findFirstOrThrow({
					where: { eventId, userId: fixture.userId },
				});
				const attempt = await repository.beginAttempt(delivery.id);
				expect(attempt).not.toBeNull();
				if (!attempt) throw new Error("Actual native marker missing");
				expect(await repository.finishAttempt(attempt, { outcome: "uncertain" })).toBe(true);
				const data = await exportDatabase(fixture.prisma, { excludeOperationalHistory: true });
				if (families === "missing") {
					delete (data as Record<string, unknown>).notificationOutboxEvents;
					delete (data as Record<string, unknown>).notificationOutboxDeliveries;
				} else {
					data.notificationOutboxEvents = [];
					data.notificationOutboxDeliveries = [];
				}
				const prepared = await prepare(data, fixture.encryptor, nativeDestination);
				const before = await nativeSnapshot(fixture);
				expect(before.deliveries[0]?.state).toBe("uncertain");
				await expect(
					restorePreparedDatabase(fixture.prisma, prepared, nativeDestination),
				).rejects.toThrow();
				expect(await nativeSnapshot(fixture)).toEqual(before);
			});
		},
	);

	it.each([
		"retry-deadline",
		"retry-ordinal",
		"attempt-token",
		"config-proof",
		"source-payload",
		"group-member-reassignment",
	] as const)(
		"native replacement cannot normalize changed %s as conserved evidence",
		async (category) => {
			const fixture = await boot();
			await fixture.run(async () => {
				const data = await completeGraph(fixture);
				const prepared = await prepare(data, fixture.encryptor, nativeDestination);
				if (category === "group-member-reassignment") {
					const member = data.notificationOutboxEvents.find((row) => row.stage === "grouped")!;
					const alternate = data.notificationOutboxEvents.find(
						(row) => row.stage === "ready" && row.id !== member.aggregateParentId,
					)!;
					await fixture.prisma.notificationOutboxEvent.update({
						where: { id: member.id },
						data: { aggregateParentId: alternate.id },
					});
				}
				if (category === "retry-deadline" || category === "retry-ordinal") {
					const row = await fixture.prisma.notificationOutboxDelivery.findFirstOrThrow({
						where: { userId: fixture.userId, state: "retry-waiting" },
					});
					await fixture.prisma.notificationOutboxDelivery.update({
						where: { id: row.id },
						data:
							category === "retry-deadline"
								? { nextAttemptAt: new Date(row.nextAttemptAt.getTime() + 1000) }
								: { attemptOrdinal: row.attemptOrdinal + 1 },
					});
				} else if (category === "attempt-token" || category === "config-proof") {
					const row = await fixture.prisma.notificationOutboxDelivery.findFirstOrThrow({
						where: { userId: fixture.userId, state: "uncertain" },
					});
					await fixture.prisma.notificationOutboxDelivery.update({
						where: { id: row.id },
						data:
							category === "attempt-token"
								? { attemptToken: "00000000-0000-4000-8000-000000000007" }
								: { attemptConfigFingerprint: "f".repeat(64) },
					});
				} else if (category === "source-payload") {
					const row = await fixture.prisma.notificationOutboxEvent.findFirstOrThrow({
						where: { userId: fixture.userId, stage: "deferred" },
					});
					const envelope = JSON.parse(
						fixture.encryptor.decrypt({ value: row.encryptedPayload, iv: row.payloadIv }),
					);
					envelope.payload.body = "Synthetic changed accepted payload";
					const changed = fixture.encryptor.encrypt(JSON.stringify(envelope));
					await fixture.prisma.notificationOutboxEvent.update({
						where: { id: row.id },
						data: { encryptedPayload: changed.value, payloadIv: changed.iv },
					});
				}
				const before = await nativeSnapshot(fixture);
				await expect(
					restorePreparedDatabase(fixture.prisma, prepared, nativeDestination),
				).rejects.toThrow();
				expect(await nativeSnapshot(fixture)).toEqual(before);
			});
		},
		30000,
	);

	it("native replacement repeats the original cross-key backup without resetting historical outcomes", async () => {
		const fixture = await boot();
		await fixture.run(async () => {
			const original = await completeGraph(fixture);
			const destination = new Encryptor("a".repeat(64));
			await restorePreparedDatabase(
				fixture.prisma,
				await prepare(original, destination, nativeDestination),
				nativeDestination,
			);
			const first = await nativeSnapshot(fixture);
			await restorePreparedDatabase(
				fixture.prisma,
				await prepare(original, destination, nativeDestination),
				nativeDestination,
			);
			const second = await nativeSnapshot(fixture);
			expect(second.deliveries).toEqual(first.deliveries);
			for (const row of second.events) {
				const previous = first.events.find((old) => old.id === row.id)!;
				expect({
					...row,
					encryptedPayload: previous.encryptedPayload,
					payloadIv: previous.payloadIv,
				}).toEqual(previous);
			}
		});
	}, 30000);

	it("native replacement rolls back every destructive write after a real insert failure and can retry", async () => {
		const fixture = await boot();
		await fixture.run(async () => {
			const data = await completeGraph(fixture);
			const prepared = await prepare(data, fixture.encryptor, nativeDestination);
			const before = await nativeSnapshot(fixture);
			if (fixture.engine === "postgresql") {
				await fixture.prisma.$executeRawUnsafe(
					"CREATE FUNCTION \"SyntheticOutboxRestoreFailureFn\"() RETURNS trigger AS $$ BEGIN RAISE EXCEPTION 'synthetic restore insert failure'; END; $$ LANGUAGE plpgsql",
				);
				await fixture.prisma.$executeRawUnsafe(
					'CREATE TRIGGER "SyntheticOutboxRestoreFailure" BEFORE INSERT ON "NotificationOutboxDelivery" FOR EACH ROW EXECUTE FUNCTION "SyntheticOutboxRestoreFailureFn"()',
				);
			} else
				await fixture.prisma.$executeRawUnsafe(
					'CREATE TRIGGER "SyntheticOutboxRestoreFailure" BEFORE INSERT ON "NotificationOutboxDelivery" BEGIN SELECT RAISE(ABORT, \'synthetic restore insert failure\'); END',
				);
			try {
				await expect(
					restorePreparedDatabase(fixture.prisma, prepared, nativeDestination),
				).rejects.toThrow();
				expect(await nativeSnapshot(fixture)).toEqual(before);
			} finally {
				await fixture.prisma.$executeRawUnsafe(
					fixture.engine === "postgresql"
						? 'DROP TRIGGER "SyntheticOutboxRestoreFailure" ON "NotificationOutboxDelivery"'
						: 'DROP TRIGGER "SyntheticOutboxRestoreFailure"',
				);
				if (fixture.engine === "postgresql")
					await fixture.prisma.$executeRawUnsafe(
						'DROP FUNCTION "SyntheticOutboxRestoreFailureFn"()',
					);
			}
			await restorePreparedDatabase(fixture.prisma, prepared, nativeDestination);
			expect((await nativeSnapshot(fixture)).events).toHaveLength(12);
		});
	}, 30000);

	it("native replacement commits through actual maintenance and restarts without dispatching imported work", async () => {
		const fixture = await boot();
		const destination = new Encryptor("a".repeat(64));
		const prepared = await fixture.run(async () =>
			prepare(await completeGraph(fixture), destination, nativeDestination),
		);
		let committedId: string | undefined;
		await withRestoreRuntimeReplacement(fixture.runtime, prepared, async (scope) => {
			const context = getRestoreRuntimeReplacementClientContext(scope);
			const writer = createRuntimeReplacementPrismaClient(scope);
			try {
				await restorePreparedDatabase(
					writer.prisma,
					prepared,
					nativeDestination,
					context.commitRequest,
				);
				committedId = context.restoreId;
			} finally {
				await writer.close();
			}
			expect(await context.readClosedPublicationOutcome()).toBe("committed");
		});
		await fixture.restart();
		await fixture.run(async () => {
			expect(await readRestoreRuntimeControl(fixture.prisma)).toMatchObject({
				lastCommittedRestoreId: committedId,
			});
			expect((await nativeSnapshot(fixture)).events).toHaveLength(12);
		});
		const sent: string[] = [];
		const dispatcher = new NotificationDispatcher();
		dispatcher.registerSender("DISCORD", {
			async send(_config, payload) {
				sent.push(payload.title);
				return { success: true, retryable: false };
			},
			async test() {
				throw new Error("No provider test in owned fixture");
			},
		});
		const repository = createNotificationOutboxRepository(
			fixture.prisma,
			fixture.runtime,
			destination,
			fixture.userId,
			{ clock: fixture.clock },
		);
		const worker = createNotificationOutboxWorker({
			repository,
			runtime: fixture.runtime,
			dispatcher,
			logger: { info() {}, warn() {}, error() {}, debug() {} },
			clock: fixture.clock,
		});
		try {
			await worker.start();
			await worker.wake();
			expect(sent).toEqual([]);
			await fixture.run(() =>
				repository.admit({
					...fixture.input(),
					payload: { ...fixture.payload, title: "Synthetic new post-Restore work" },
				}),
			);
			await worker.wake();
			expect(sent).toEqual(["Synthetic new post-Restore work"]);
		} finally {
			worker.closeAdmission();
			await worker.drain();
		}
	}, 30000);

	it.each([
		["prepared", "missing"],
		["prepared", "empty"],
		["raw", "missing"],
		["raw", "empty"],
	] as const)(
		"native replacement refuses %s legacy %s erasure of unfinished work",
		async (path, families) => {
			const fixture = await boot();
			await fixture.run(async () => {
				await fixture.repository().admit(fixture.input());
				const data = await exportDatabase(fixture.prisma, { excludeOperationalHistory: true });
				if (families === "missing") {
					delete (data as Record<string, unknown>).notificationOutboxEvents;
					delete (data as Record<string, unknown>).notificationOutboxDeliveries;
				} else {
					data.notificationOutboxEvents = [];
					data.notificationOutboxDeliveries = [];
				}
				const before = await nativeSnapshot(fixture);
				const publication =
					path === "raw"
						? restoreDatabase(fixture.prisma, data)
						: restorePreparedDatabase(
								fixture.prisma,
								await prepare(data, fixture.encryptor, nativeDestination),
								nativeDestination,
							);
				await expect(publication).rejects.toThrow();
				expect(await nativeSnapshot(fixture)).toEqual(before);
			});
		},
	);

	it("native replacement refuses unprepared notification ciphertext", async () => {
		const fixture = await boot();
		await fixture.run(async () => {
			await fixture.repository().admit(fixture.input());
			const data = await exportDatabase(fixture.prisma, { excludeOperationalHistory: true });
			const before = await nativeSnapshot(fixture);
			await expect(restoreDatabase(fixture.prisma, data)).rejects.toThrow();
			expect(await nativeSnapshot(fixture)).toEqual(before);
		});
	});

	it("native replacement persists authenticated imported work without restoring send eligibility", async () => {
		const fixture = await boot();
		await fixture.run(async () => {
			await fixture.repository().admit(fixture.input());
			const data = await exportDatabase(fixture.prisma, { excludeOperationalHistory: true });
			const prepared = await prepare(data, new Encryptor("a".repeat(64)), nativeDestination);
			await restorePreparedDatabase(fixture.prisma, prepared, nativeDestination);
			const actual = await nativeSnapshot(fixture);
			expect(actual.events).toHaveLength(1);
			expect(actual.deliveries).toHaveLength(1);
			expect(JSON.parse(JSON.stringify(actual.events))).toEqual(
				prepared.records.notificationOutboxEvents,
			);
			expect(JSON.parse(JSON.stringify(actual.deliveries))).toEqual(
				prepared.records.notificationOutboxDeliveries,
			);
			expect(actual.events[0]?.stage).toBe("terminal");
			expect(actual.deliveries[0]).toMatchObject({
				state: "canceled",
				outcomeCategory: "restored-not-replayed",
				attemptOrdinal: 0,
			});
			expect(actual.logs).toHaveLength(0);
		});
	});

	describe("native replacement of a complete historical graph", () => {
		let fixture: Fixture;
		let data: Awaited<ReturnType<typeof completeGraph>>;
		beforeEach(async () => {
			fixture = await boot();
			data = await fixture.run(() => completeGraph(fixture));
		});
		it("native replacement conserves grouped lineage and every historical attempt", async () => {
			await fixture.run(async () => {
				const prepared = await prepare(data, new Encryptor("a".repeat(64)), nativeDestination);
				await restorePreparedDatabase(fixture.prisma, prepared, nativeDestination);
				const actual = await nativeSnapshot(fixture);
				expect(actual.events).toHaveLength(12);
				expect(actual.deliveries).toHaveLength(12);
				for (const row of actual.events)
					expect(JSON.parse(JSON.stringify(row))).toEqual(
						(prepared.records.notificationOutboxEvents as Record<string, unknown>[]).find(
							(old) => old.id === row.id,
						),
					);
				for (const row of actual.deliveries)
					expect(JSON.parse(JSON.stringify(row))).toEqual(
						(prepared.records.notificationOutboxDeliveries as Record<string, unknown>[]).find(
							(old) => old.id === row.id,
						),
					);
				expect(actual.events.filter((row) => row.stage === "grouped")).toHaveLength(2);
				expect(actual.deliveries.filter((row) => row.state === "uncertain")).toHaveLength(2);
			});
		});
	});

	it("native replacement refuses actual admission between root checks and destructive transaction", async () => {
		const fixture = await boot();
		await fixture.run(async () => {
			await fixture.repository().admit(fixture.input());
			const data = await exportDatabase(fixture.prisma, { excludeOperationalHistory: true });
			const prepared = await prepare(data, fixture.encryptor, nativeDestination);
			let expected: Awaited<ReturnType<typeof nativeSnapshot>> | undefined;
			const barrier = new Proxy(fixture.prisma, {
				get(client, property) {
					if (property !== "$transaction") return Reflect.get(client, property, client);
					return async (...args: unknown[]) => {
						expect(expected).toBeUndefined();
						await fixture.repository().admit({
							...fixture.input(),
							payload: { ...fixture.payload, title: "Synthetic admitted between boundaries" },
						});
						expected = await nativeSnapshot(fixture);
						return Reflect.apply(client.$transaction, client, args);
					};
				},
			});
			await expect(restorePreparedDatabase(barrier, prepared, nativeDestination)).rejects.toThrow();
			expect(expected?.events).toHaveLength(2);
			expect(await nativeSnapshot(fixture)).toEqual(expected);
		});
	});

	it("accepts every genuine delivery state and complete aggregation lineage", async () => {
		const fixture = await boot();
		await fixture.run(async () => {
			const data = await completeGraph(fixture);
			expect(() => validateBackup(backup(data))).not.toThrow();
			// A removed recipient is still historical evidence, not a restrictive FK.
			await fixture.prisma.notificationChannel.delete({ where: { id: fixture.channelId } });
			const removed = await exportDatabase(fixture.prisma, { excludeOperationalHistory: true });
			expect(removed.notificationOutboxDeliveries).toHaveLength(12);
			expect(() => validateBackup(backup(removed))).not.toThrow();
		});
	});

	it("authenticates and rekeys all payloads while quarantining imported unfinished work", async () => {
		const fixture = await boot();
		await fixture.run(async () => {
			const data = await completeGraph(fixture);
			const before = JSON.stringify(data);
			const destination = new Encryptor("a".repeat(64));
			const prepared = await prepare(data, destination);
			expect(JSON.stringify(data)).toBe(before);
			expect(originalPreparedRestoreRecords(prepared).notificationOutboxEvents).toEqual(
				JSON.parse(JSON.stringify(data.notificationOutboxEvents)),
			);
			const events = prepared.records.notificationOutboxEvents as Record<string, unknown>[];
			const deliveries = prepared.records.notificationOutboxDeliveries as Record<string, unknown>[];
			expect(events).toHaveLength(12);
			expect(deliveries).toHaveLength(12);
			for (const old of data.notificationOutboxEvents) {
				const current = events.find((row) => row.id === old.id)!;
				expect(
					destination.decrypt({
						value: current.encryptedPayload as string,
						iv: current.payloadIv as string,
					}),
				).toBe(fixture.encryptor.decrypt({ value: old.encryptedPayload, iv: old.payloadIv }));
				expect(current.payloadIv).not.toBe(old.payloadIv);
				expect(current.dedupFingerprint).not.toBe(old.dedupFingerprint);
				expect(current.scopeFingerprint).not.toBe(old.scopeFingerprint);
				expect(current.destinationInstallationId).toBe(old.destinationInstallationId);
				expect(current.restoreCommitId).toBe(old.restoreCommitId);
				expect(current.aggregateParentId).toBe(old.aggregateParentId);
			}
			expect(deliveries.filter((row) => row.state === "canceled")).toHaveLength(8);
			expect(deliveries.filter((row) => row.state === "uncertain")).toHaveLength(2);
			expect(deliveries.filter((row) => row.state === "sent")).toHaveLength(1);
			expect(deliveries.filter((row) => row.state === "rejected")).toHaveLength(1);
			expect(events.filter((row) => row.stage === "terminal")).toHaveLength(10);
			expect(events.filter((row) => row.stage === "grouped")).toHaveLength(2);
			for (const old of data.notificationOutboxDeliveries) {
				const current = deliveries.find((row) => row.id === old.id)!;
				expect(current.attemptOrdinal).toBe(old.attemptOrdinal);
				expect(current.nextAttemptAt).toBe(old.nextAttemptAt.toISOString());
				expect(current.attemptToken).toBe(old.attemptToken);
				expect(current.dispatchedAt).toBe(old.dispatchedAt?.toISOString() ?? null);
				if (["ready", "waiting", "retry-waiting", "submitting"].includes(old.state))
					expect(current.outcomeCategory).toBe("restored-not-replayed");
			}
			expect(() => validateBackup({ ...backup(data), data: prepared.records })).not.toThrow();
		});
		// Keep the complete native graph and real KDF-backed rekeying in this case.
	}, 15_000);

	it.each([
		"ciphertext",
		"fingerprint",
		"envelope-owner",
		"envelope-event",
		"envelope-recipient",
		"envelope-binding",
		"envelope-due",
		"envelope-policy",
		"envelope-extra-field",
	] as const)("refuses unauthenticated notification payload: %s", async (category) => {
		const fixture = await boot();
		await fixture.run(async () => {
			await fixture.repository().admit(fixture.input());
			const data = await exportDatabase(fixture.prisma, { excludeOperationalHistory: true });
			const row = data.notificationOutboxEvents[0]!;
			if (category === "ciphertext") row.encryptedPayload = Buffer.alloc(32).toString("base64");
			else if (category === "fingerprint") row.scopeFingerprint = "f".repeat(64);
			else {
				const envelope = JSON.parse(
					fixture.encryptor.decrypt({ value: row.encryptedPayload, iv: row.payloadIv }),
				);
				if (category === "envelope-owner") envelope.userId = "synthetic-other-owner";
				if (category === "envelope-event")
					envelope.eventId = "00000000-0000-4000-8000-000000000004";
				if (category === "envelope-recipient")
					envelope.recipients[0].channelId = "synthetic-other-channel";
				if (category === "envelope-binding")
					envelope.destinationInstallationId = "synthetic-other-binding";
				if (category === "envelope-due") envelope.dueAt = "2026-10-10T13:00:00.000Z";
				if (category === "envelope-policy")
					envelope.policy = { stage: "deferred", dueAt: envelope.dueAt };
				if (category === "envelope-extra-field") envelope.authority = "invented";
				const changed = fixture.encryptor.encrypt(JSON.stringify(envelope));
				row.encryptedPayload = changed.value;
				row.payloadIv = changed.iv;
			}
			await expect(prepare(data)).rejects.toThrow();
		});
	});
	it("exports explicit empty outbox families independently of optional History", async () => {
		const fixture = await boot();
		await fixture.run(async () => {
			const data = await exportDatabase(fixture.prisma, {
				excludeOperationalHistory: true,
				historyRetentionLimit: 1,
			});
			expect(data).toMatchObject({
				notificationOutboxEvents: [],
				notificationOutboxDeliveries: [],
			});
		});
	});

	it("accepts a genuine committed graph and historical omission without inventing coverage", async () => {
		const fixture = await boot();
		await fixture.run(async () => {
			await fixture.repository().admit(fixture.input());
			const data = await exportDatabase(fixture.prisma, { excludeOperationalHistory: true });
			expect(() => validateBackup(backup(data))).not.toThrow();
			const legacy: Record<string, unknown> = { ...data };
			delete legacy.notificationOutboxEvents;
			delete legacy.notificationOutboxDeliveries;
			expect(() => validateBackup({ ...backup(data), data: legacy })).not.toThrow();
		});
	});

	it.each([
		"missing-deliveries",
		"missing-events",
		"duplicate-event",
		"duplicate-delivery",
		"duplicate-recipient",
		"orphan-delivery",
		"cross-owner-delivery",
		"missing-owner",
		"no-recipients",
		"ready-with-marker",
		"retry-without-evidence",
		"sent-without-attempt",
		"terminal-with-ready-recipient",
		"grouped-without-parent",
		"parent-outside-group",
		"invalid-event-stage",
		"unknown-delivery-field",
	] as const)("rejects additive malformed notification graph: %s", async (category) => {
		const fixture = await boot();
		await fixture.run(async () => {
			await fixture.repository().admit(fixture.input());
			const data = await exportDatabase(fixture.prisma, { excludeOperationalHistory: true });
			// Establish that the unmodified native fixture passes this same public boundary.
			expect(() => validateBackup(backup(data))).not.toThrow();
			const event = data.notificationOutboxEvents[0]!;
			const delivery = data.notificationOutboxDeliveries[0]!;
			const malformed: Record<string, unknown> = {
				...data,
				notificationOutboxEvents: [{ ...event }],
				notificationOutboxDeliveries: [{ ...delivery }],
			};
			const changedEvent = { ...event } as Record<string, unknown>;
			const changedDelivery = { ...delivery } as Record<string, unknown>;
			switch (category) {
				case "missing-deliveries":
					delete malformed.notificationOutboxDeliveries;
					break;
				case "missing-events":
					delete malformed.notificationOutboxEvents;
					break;
				case "duplicate-event":
					malformed.notificationOutboxEvents = [event, { ...event }];
					break;
				case "duplicate-delivery":
					malformed.notificationOutboxDeliveries = [delivery, { ...delivery }];
					break;
				case "duplicate-recipient":
					malformed.notificationOutboxDeliveries = [
						delivery,
						{ ...delivery, id: "00000000-0000-4000-8000-000000000001" },
					];
					break;
				case "orphan-delivery":
					changedDelivery.eventId = "00000000-0000-4000-8000-000000000002";
					break;
				case "cross-owner-delivery":
					changedDelivery.userId = (await fixture.createOwner()).userId;
					malformed.users = await fixture.prisma.user.findMany();
					break;
				case "missing-owner":
					malformed.users = [];
					break;
				case "no-recipients":
					malformed.notificationOutboxDeliveries = [];
					break;
				case "ready-with-marker":
					changedDelivery.attemptToken = "00000000-0000-4000-8000-000000000003";
					break;
				case "retry-without-evidence":
					changedDelivery.state = "retry-waiting";
					changedDelivery.attemptOrdinal = 1;
					break;
				case "sent-without-attempt":
					changedDelivery.state = "sent";
					changedDelivery.completedAt = fixture.now;
					break;
				case "terminal-with-ready-recipient":
					changedEvent.stage = "terminal";
					break;
				case "grouped-without-parent":
					changedEvent.stage = "grouped";
					break;
				case "parent-outside-group":
					changedEvent.aggregateParentId = event.id;
					break;
				case "invalid-event-stage":
					changedEvent.stage = "invented";
					break;
				case "unknown-delivery-field":
					changedDelivery.unexpectedAuthority = true;
					break;
			}
			if (JSON.stringify(changedEvent) !== JSON.stringify(event))
				malformed.notificationOutboxEvents = [changedEvent];
			if (JSON.stringify(changedDelivery) !== JSON.stringify(delivery))
				malformed.notificationOutboxDeliveries = [changedDelivery];
			expect(() => validateBackup({ ...backup(data), data: malformed })).toThrow();
		});
	});

	it("conserves all encrypted pending events and recipients despite History exclusion and cap1", async () => {
		const fixture = await boot();
		await fixture.run(async () => {
			const policies: NotificationOutboxPolicy[] = [
				{ stage: "ready" },
				{ stage: "deferred", dueAt: new Date(fixture.now.getTime() + 90_000) },
				{ stage: "aggregating", windowSeconds: 60, maxBatchSize: 10 },
			];
			for (const [index, policy] of policies.entries())
				await fixture.repository().admit({
					...fixture.input(),
					payload: { ...fixture.payload, title: `Synthetic portable notification ${index}` },
					policy,
				});
			// Read committed native state independently of the exporter under test.
			const events = await fixture.prisma.notificationOutboxEvent.findMany({
				where: { userId: fixture.userId },
				orderBy: { id: "asc" },
			});
			const deliveries = await fixture.prisma.notificationOutboxDelivery.findMany({
				where: { userId: fixture.userId },
				orderBy: { id: "asc" },
			});
			expect(events).toHaveLength(3);
			expect(deliveries).toHaveLength(3);
			expect(events.map((event) => event.stage).sort()).toEqual([
				"aggregating",
				"deferred",
				"ready",
			]);
			const data: Record<string, unknown> = await exportDatabase(fixture.prisma, {
				excludeOperationalHistory: true,
				historyRetentionLimit: 1,
			});
			expect(data.notificationOutboxEvents).toEqual(expect.arrayContaining(events));
			expect(data.notificationOutboxEvents).toHaveLength(3);
			expect(data.notificationOutboxDeliveries).toEqual(expect.arrayContaining(deliveries));
			expect(data.notificationOutboxDeliveries).toHaveLength(3);
		});
	});
});
