import Fastify from "fastify";
import { afterEach, describe, expect, it, vi } from "vitest";
import {
	closeScopedWriteFixtures,
	createScopedWriteFixture,
} from "../../__tests__/scoped-write-intent-fixture.js";
import { Encryptor } from "../../auth/encryption.js";
import { executeOnJellyfinInstances } from "../../jellyfin/jellyfin-helpers.js";
import { executeOnPlexInstances } from "../../plex/plex-helpers.js";
import { withIsolatedRuntimePrismaReadClient } from "../restore-runtime-client.js";

afterEach(async () => {
	vi.unstubAllGlobals();
	await closeScopedWriteFixtures();
});

describe("multi-instance provider selection read acquisition", { timeout: 20_000 }, () => {
	// Break caught: selecting provider instances must neither wait on/borrow an
	// ordinary transaction nor hold a database read lane across provider work.
	it.each(["PLEX", "JELLYFIN"] as const)(
		"selects committed owned enabled %s sources and releases its lane before callbacks",
		async (service) => {
			const f = await createScopedWriteFixture({ writeIntent: true });
			const encryptor = new Encryptor("9".repeat(64));
			const encrypted = encryptor.encrypt("synthetic-only-provider-token");
			const instanceData = {
				userId: "synthetic-user",
				service,
				baseUrl: "http://synthetic.invalid",
				encryptedApiKey: encrypted.value,
				encryptionIv: encrypted.iv,
			};
			const primaryId = service === "PLEX" ? "synthetic-plex" : "synthetic-jellyfin";
			await f.plain.serviceInstance.update({
				where: { id: primaryId },
				data: { ...instanceData, label: "A committed" },
			});
			await f.plain.user.create({ data: { id: "foreign-user", username: "foreign-user" } });
			await f.plain.serviceInstance.createMany({
				data: [
					{
						...instanceData,
						id: "owned-failure",
						label: "B committed",
						service: service === "PLEX" ? "PLEX" : "EMBY",
					},
					{ ...instanceData, id: "owned-disabled", label: "Disabled", enabled: false },
					{ ...instanceData, id: "foreign-instance", label: "Foreign", userId: "foreign-user" },
				],
			});
			const app = Fastify({ logger: false });
			app.decorate("prisma", f.client.prisma);
			app.decorate("encryptor", encryptor);
			// Real clients contain only synthetic credentials/URLs; provider callbacks
			// below perform no network I/O, and accidental requests are rejected.
			vi.stubGlobal("fetch", () => {
				throw new Error("Unexpected provider network request");
			});
			const execute = service === "PLEX" ? executeOnPlexInstances : executeOnJellyfinInstances;
			let releaseTransaction = () => {};
			let releaseCallbacks = () => {};
			let publication: Promise<unknown> | undefined;
			let completed: Promise<unknown> | undefined;
			try {
				let entered!: () => void;
				const transactionEntered = new Promise<void>((resolve) => {
					entered = resolve;
				});
				const heldTransaction = new Promise<void>((resolve) => {
					releaseTransaction = resolve;
				});
				const rollback = new Error("synthetic-provider-selection-rollback");
				publication = f.runtime
					.runOperation(() =>
						f.client.prisma.$transaction(
							async (tx) => {
								await tx.serviceInstance.update({
									where: { id: primaryId },
									data: { enabled: false, label: "Uncommitted", userId: "foreign-user" },
								});
								await tx.serviceInstance.update({
									where: { id: "foreign-instance" },
									data: { userId: "synthetic-user" },
								});
								await tx.serviceInstance.create({
									data: { ...instanceData, id: "uncommitted-instance", label: "Uncommitted new" },
								});
								entered();
								await heldTransaction;
								throw rollback;
							},
							{ timeout: 15_000 },
						),
					)
					.then(
						() => null,
						(error: unknown) => error,
					);
				await transactionEntered;
				let callbacksEntered!: () => void;
				const allCallbacksEntered = new Promise<void>((resolve) => {
					callbacksEntered = resolve;
				});
				const heldCallbacks = new Promise<void>((resolve) => {
					releaseCallbacks = resolve;
				});
				const enteredOperations = new Set<number>();
				const operations = Array.from({ length: 4 }, (_, index) =>
					f.runtime.runOperation(() =>
						execute(app, "synthetic-user", async (_client, instance) => {
							enteredOperations.add(index);
							if (enteredOperations.size === 4) callbacksEntered();
							await heldCallbacks;
							if (instance.id === "owned-failure") throw new Error("Synthetic provider failure");
							return [instance.id, instance.label, "synthetic-result"];
						}),
					),
				);
				completed = Promise.all(operations);
				await Promise.race([
					allCallbacksEntered,
					completed.then(() => {
						throw new Error("Provider callbacks did not remain pending");
					}),
				]);
				// Four provider operations are waiting. A SELECT must still acquire a
				// lane; retaining their leases across callbacks would exhaust the pool.
				expect(
					await f.runtime.runOperation(() =>
						withIsolatedRuntimePrismaReadClient(f.client.prisma, (reader) =>
							reader.serviceInstance.findMany({
								where: { id: primaryId, userId: "synthetic-user", enabled: true },
								select: { id: true, label: true },
							}),
						),
					),
				).toEqual([{ id: primaryId, label: "A committed" }]);
				releaseCallbacks();
				for (const result of await Promise.all(operations)) {
					expect(result).toEqual({
						instances: [
							{
								instanceId: primaryId,
								instanceName: "A committed",
								success: true,
								data: [primaryId, "A committed", "synthetic-result"],
							},
							{
								instanceId: "owned-failure",
								instanceName: "B committed",
								success: false,
								error: "Synthetic provider failure",
							},
						],
						aggregated: [primaryId, "A committed", "synthetic-result"],
						totalCount: service === "PLEX" ? 3 : 2,
						errorCount: 1,
					});
				}
				releaseTransaction();
				expect(await publication).toBe(rollback);
				await f.plain.serviceInstance.updateMany({
					where: { userId: "synthetic-user", service: { in: ["PLEX", "JELLYFIN", "EMBY"] } },
					data: { enabled: false },
				});
				expect(
					await f.runtime.runOperation(() =>
						execute(app, "synthetic-user", async () => {
							throw new Error("Disabled source callback must not run");
						}),
					),
				).toEqual({ instances: [], aggregated: [], totalCount: 0, errorCount: 0 });
				expect(f.losses).toEqual([]);
			} finally {
				releaseCallbacks();
				releaseTransaction();
				await completed?.catch(() => {});
				await publication;
				await app.close();
			}
		},
	);
});
