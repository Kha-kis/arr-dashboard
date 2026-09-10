import { execFileSync } from "node:child_process";
import { mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { describe, expect, it } from "vitest";
import { createTestPrismaClient } from "../../__tests__/test-prisma.js";

const schemaPath = join(process.cwd(), "prisma", "schema.prisma");

function pushSchema(databasePath: string) {
	execFileSync("pnpm", ["exec", "prisma", "db", "push", "--schema", schemaPath], {
		cwd: process.cwd(),
		env: { ...process.env, DATABASE_URL: `file:${databasePath}` },
		stdio: "ignore",
	});
}

describe("LabelSyncMutationAttempt schema", () => {
	async function fixture(prisma: ReturnType<typeof createTestPrismaClient>) {
		const user = await prisma.user.create({
			data: { username: `schema-${Date.now()}-${Math.random()}` },
		});
		const instance = await prisma.serviceInstance.create({
			data: {
				userId: user.id,
				service: "JELLYFIN",
				label: "schema-instance",
				baseUrl: "http://127.0.0.1:8096",
				encryptedApiKey: "encrypted",
				encryptionIv: "iv",
			},
		});
		const rule = await prisma.labelSyncRule.create({
			data: {
				userId: user.id,
				name: "schema-rule",
				sourceService: "radarr",
				sourceTagName: "source",
				destService: "jellyfin",
				destInstanceId: instance.id,
				destTagName: "destination",
			},
		});
		return { user, instance, rule };
	}

	function attemptData(
		fixture: { user: { id: string }; instance: { id: string }; rule: { id: string } },
		id: string,
		activeOperationKey: string | null,
	) {
		return {
			id,
			userId: fixture.user.id,
			ruleId: fixture.rule.id,
			destinationInstanceId: fixture.instance.id,
			provider: "jellyfin",
			mediaType: "movie",
			tmdbId: 1,
			connectionGeneration: 0,
			identityGeneration: 0,
			targetItemId: "item",
			libraryId: "library",
			intentFingerprint: id,
			ruleFingerprint: "rule",
			destinationTag: "tag",
			activeOperationKey,
			claimToken: activeOperationKey ? "claim" : null,
			status: activeOperationKey ? "claimed" : "failed",
			completedAt: activeOperationKey ? null : new Date(),
		};
	}

	it("exposes the durable model fields and relations", async () => {
		const fields = [
			"id",
			"userId",
			"ruleId",
			"destinationInstanceId",
			"provider",
			"mediaType",
			"tmdbId",
			"connectionGeneration",
			"identityGeneration",
			"targetItemId",
			"libraryId",
			"intentFingerprint",
			"ruleFingerprint",
			"destinationTag",
			"activeOperationKey",
			"claimToken",
			"sendAttemptCount",
			"reconcileAttemptCount",
			"requestStartedAt",
			"lastObservedAt",
			"completedAt",
			"status",
			"reasonCode",
			"createdAt",
			"updatedAt",
		];
		const directory = mkdtempSync(join(tmpdir(), "label-sync-schema-"));
		const dbPath = join(directory, "test.db");
		try {
			pushSchema(dbPath);
			const prisma = createTestPrismaClient(dbPath);
			const user = await prisma.user.create({ data: { username: "schema-user" } });
			const instance = await prisma.serviceInstance.create({
				data: {
					userId: user.id,
					service: "JELLYFIN",
					label: "schema-instance",
					baseUrl: "http://127.0.0.1:8096",
					encryptedApiKey: "encrypted",
					encryptionIv: "iv",
				},
			});
			const rule = await prisma.labelSyncRule.create({
				data: {
					userId: user.id,
					name: "schema-rule",
					sourceService: "radarr",
					sourceTagName: "source",
					destService: "jellyfin",
					destInstanceId: instance.id,
					destTagName: "destination",
				},
			});
			const row = await prisma.labelSyncMutationAttempt.create({
				data: {
					id: "attempt-schema",
					userId: user.id,
					ruleId: rule.id,
					destinationInstanceId: instance.id,
					provider: "jellyfin",
					mediaType: "movie",
					tmdbId: 1,
					connectionGeneration: 0,
					identityGeneration: 0,
					targetItemId: "item",
					libraryId: "library",
					intentFingerprint: "intent",
					ruleFingerprint: "rule",
					destinationTag: "tag",
					activeOperationKey: "active",
					claimToken: "claim",
					status: "claimed",
				},
				include: { owner: true, rule: true, destination: true },
			});
			for (const field of fields) expect(field in row).toBe(true);
			expect(row.owner.id).toBe(user.id);
			expect(row.rule.id).toBe(rule.id);
			expect(row.destination.id).toBe(instance.id);
			await prisma.$disconnect();
		} finally {
			rmSync(directory, { recursive: true, force: true });
		}
	}, 120_000);

	it("enforces nullable unique active keys and restricts parent deletion", async () => {
		const directory = mkdtempSync(join(tmpdir(), "label-sync-schema-"));
		const dbPath = join(directory, "test.db");
		try {
			pushSchema(dbPath);
			const prisma = createTestPrismaClient(dbPath);
			const parents = await fixture(prisma);
			const foreignKeys = await prisma.$queryRawUnsafe<
				Array<{ table: string; from: string; to: string; on_delete: string }>
			>(`PRAGMA foreign_key_list("label_sync_mutation_attempts")`);
			const ownerForeignKey = foreignKeys.find(
				(foreignKey) =>
					foreignKey.table.toLowerCase() === "user" &&
					foreignKey.from === "userId" &&
					foreignKey.to === "id",
			);
			expect(ownerForeignKey?.on_delete).toBe("RESTRICT");
			await prisma.labelSyncMutationAttempt.create({
				data: attemptData(parents, "active", "active-key"),
			});
			await expect(
				prisma.labelSyncMutationAttempt.create({
					data: attemptData(parents, "duplicate", "active-key"),
				}),
			).rejects.toThrow();
			await prisma.labelSyncMutationAttempt.create({
				data: attemptData(parents, "terminal-1", null),
			});
			await prisma.labelSyncMutationAttempt.create({
				data: attemptData(parents, "terminal-2", null),
			});
			await expect(
				prisma.labelSyncRule.delete({ where: { id: parents.rule.id } }),
			).rejects.toThrow();
			await expect(
				prisma.serviceInstance.delete({ where: { id: parents.instance.id } }),
			).rejects.toThrow();
			await expect(prisma.user.delete({ where: { id: parents.user.id } })).rejects.toThrow();
			await prisma.labelSyncMutationAttempt.deleteMany();
			await expect(prisma.user.delete({ where: { id: parents.user.id } })).resolves.toMatchObject({
				id: parents.user.id,
			});
			await prisma.$disconnect();
		} finally {
			rmSync(directory, { recursive: true, force: true });
		}
	}, 120_000);
});
