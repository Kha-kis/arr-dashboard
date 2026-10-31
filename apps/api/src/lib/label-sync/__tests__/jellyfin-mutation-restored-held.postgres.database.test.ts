import { execFileSync } from "node:child_process";
import { randomUUID } from "node:crypto";
import { mkdtempSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { pathToFileURL } from "node:url";
import { PrismaPg } from "@prisma/adapter-pg";
import { Pool } from "pg";
import { afterAll, beforeAll, describe, expect, it } from "vitest";
import type { PrismaClient } from "../../prisma.js";
import {
	JellyfinMutationRepository,
	type MutationClaimInput,
	recoverLabelSyncMutationAttempts,
} from "../jellyfin-mutation-repository.js";
import { prepareRestoredLabelSyncMutationAttempt } from "../jellyfin-mutation-restore.js";
import { parseLabelSyncMutationAttempt } from "../jellyfin-mutation-state.js";

const configuredUrl = process.env.TEST_DATABASE_URL;
let url: URL | undefined;
try {
	if (configuredUrl) url = new URL(configuredUrl);
} catch {
	url = undefined;
}
const enabled =
	process.env.INTEGRATION_TESTS === "true" &&
	url !== undefined &&
	["postgres:", "postgresql:"].includes(url.protocol) &&
	["127.0.0.1", "localhost", "[::1]"].includes(url.hostname) &&
	/^\/[A-Za-z_][A-Za-z0-9_]*_test$/.test(url.pathname) &&
	!url.search &&
	!url.hash;
const pgDescribe = enabled ? describe : describe.skip;

function isolatedSchema(source: string, schema: string) {
	const transformed = source
		.replace(
			/generator client \{[\s\S]*?\}\n\n/,
			'generator client {\n  provider = "prisma-client"\n  output = "./generated"\n}\n\n',
		)
		.replace(
			/datasource db \{\s*provider = "sqlite"\s*\}/,
			`datasource db {\n  provider = "postgresql"\n  schemas = ["${schema}"]\n}`,
		);
	return transformed.replace(/^(model|enum) \w+ \{[\s\S]*?^\}/gm, (block) =>
		block.replace(/\}$/, `  @@schema("${schema}")\n}`),
	);
}

pgDescribe("restored-held PostgreSQL persistence and fenced ownership", { timeout: 30_000 }, () => {
	let admin: Pool;
	let schemaName: string;
	let directory: string;
	let schemaUrl: string;
	let Constructor: new (options: { adapter: PrismaPg }) => PrismaClient;
	const clients: PrismaClient[] = [];
	const pools: Pool[] = [];
	let number = 0;
	function client() {
		const pool = new Pool({
			connectionString: configuredUrl,
			options: `-c search_path=${schemaName}`,
		});
		pools.push(pool);
		const prisma = new Constructor({ adapter: new PrismaPg(pool, { schema: schemaName }) });
		clients.push(prisma);
		return prisma;
	}
	function push() {
		execFileSync(
			"pnpm",
			["exec", "prisma", "db", "push", "--schema", join(directory, "schema.prisma")],
			{ cwd: process.cwd(), env: { ...process.env, DATABASE_URL: schemaUrl }, stdio: "pipe" },
		);
	}
	beforeAll(async () => {
		if (!configuredUrl || !url) throw new Error("disposable PostgreSQL URL required");
		schemaName = `held_pg_${randomUUID().replaceAll("-", "")}`;
		admin = new Pool({ connectionString: configuredUrl });
		await admin.query(`CREATE SCHEMA "${schemaName}"`);
		const selected = new URL(configuredUrl);
		selected.searchParams.set("schema", schemaName);
		schemaUrl = selected.toString();
		directory = mkdtempSync(join(tmpdir(), "held-pg-schema-"));
		writeFileSync(
			join(directory, "schema.prisma"),
			isolatedSchema(readFileSync(join(process.cwd(), "prisma/schema.prisma"), "utf8"), schemaName),
			{ mode: 0o600 },
		);
		execFileSync(
			"pnpm",
			["exec", "prisma", "generate", "--schema", join(directory, "schema.prisma")],
			{ cwd: process.cwd(), env: { ...process.env, DATABASE_URL: schemaUrl }, stdio: "pipe" },
		);
		push();
		const generated = await import(
			/* @vite-ignore */ pathToFileURL(join(directory, "generated/client.ts")).href
		);
		Constructor = (generated.default ?? generated).PrismaClient;
	}, 120_000);
	async function seed() {
		const prisma = client();
		const suffix = ++number;
		const input: MutationClaimInput = {
			userId: `held-pg-owner-${suffix}`,
			ruleId: `held-pg-rule-${suffix}`,
			destinationInstanceId: `held-pg-destination-${suffix}`,
			provider: "jellyfin",
			mediaType: "movie",
			tmdbId: suffix,
			connectionGeneration: 0,
			identityGeneration: 0,
			targetItemId: `held-pg-item-${suffix}`,
			libraryId: "held-pg-library",
			intentFingerprint: "fixture-intent",
			ruleFingerprint: "fixture-rule",
			destinationTag: "managed",
		};
		await prisma.user.create({ data: { id: input.userId, username: input.userId } });
		await prisma.serviceInstance.create({
			data: {
				id: input.destinationInstanceId,
				userId: input.userId,
				service: "JELLYFIN",
				label: "fixture",
				baseUrl: "http://127.0.0.1:8096",
				encryptedApiKey: "fixture",
				encryptionIv: "fixture",
				identityStatus: "VERIFIED",
				identityKind: "JELLYFIN_SERVER_ID",
				expectedIdentity: "held-pg-server",
			},
		});
		await prisma.labelSyncRule.create({
			data: {
				id: input.ruleId,
				userId: input.userId,
				name: "fixture",
				sourceService: "radarr",
				sourceTagName: "source",
				destService: "jellyfin",
				destInstanceId: input.destinationInstanceId,
				destTagName: input.destinationTag,
			},
		});
		const repository = new JellyfinMutationRepository(prisma, { databaseProvider: "postgresql" });
		return { prisma, input, repository };
	}
	async function heldFixture(original: "claimed" | "sending" | "unknown" = "claimed") {
		const fixture = await seed();
		const claim = await fixture.repository.claim(fixture.input);
		if (claim.kind !== "acquired") throw new Error("fixture claim unavailable");
		const handle = {
			id: claim.id,
			userId: fixture.input.userId,
			ruleId: fixture.input.ruleId,
			destinationInstanceId: fixture.input.destinationInstanceId,
			activeOperationKey: claim.activeOperationKey,
		};
		if (original !== "claimed")
			await fixture.repository.markSending({
				...handle,
				claimToken: claim.claimToken,
				sendAttemptCount: 0,
			});
		if (original === "unknown")
			await fixture.repository.completeSend({
				...handle,
				claimToken: claim.claimToken,
				sendAttemptCount: 1,
				status: "unknown",
			});
		const source = await fixture.prisma.labelSyncMutationAttempt.findUniqueOrThrow({
			where: { id: claim.id },
		});
		const held = prepareRestoredLabelSyncMutationAttempt(source);
		// A pre-send backup can be restored after its original worker advances.
		if (original === "claimed")
			await fixture.repository.markSending({
				...handle,
				claimToken: claim.claimToken,
				sendAttemptCount: 0,
			});
		await fixture.prisma.$executeRawUnsafe(
			'UPDATE "label_sync_mutation_attempts" SET "status" = $1, "reasonCode" = $2, "claimToken" = NULL, "restoreEvidence" = $3, "sendAttemptCount" = $4, "requestStartedAt" = $5 WHERE "id" = $6',
			held.status,
			held.reasonCode,
			held.restoreEvidence,
			held.sendAttemptCount,
			held.requestStartedAt,
			held.id,
		);
		return { ...fixture, handle, held };
	}
	afterAll(async () => {
		try {
			await Promise.all(clients.map((prisma) => prisma.$disconnect()));
			await Promise.all(pools.map((pool) => pool.end()));
			if (admin && schemaName) await admin.query(`DROP SCHEMA "${schemaName}" CASCADE`);
		} finally {
			await admin?.end();
			if (directory) rmSync(directory, { recursive: true, force: false });
		}
	});
	it("adds nullable evidence to a populated old table without replacing native rows", async () => {
		const { prisma, repository, input } = await seed();
		const claim = await repository.claim(input);
		if (claim.kind !== "acquired") throw new Error("expected claim");
		const before = await prisma.labelSyncMutationAttempt.findUniqueOrThrow({
			where: { id: claim.id },
		});
		await prisma.$executeRawUnsafe(
			'ALTER TABLE "label_sync_mutation_attempts" DROP COLUMN "restoreEvidence"',
		);
		push();
		expect(
			await prisma.labelSyncMutationAttempt.findUniqueOrThrow({ where: { id: claim.id } }),
		).toEqual(before);
	});
	it.each(["claimed", "sending", "unknown"] as const)(
		"retains restored %s through startup and observes without acknowledgement",
		async (original) => {
			const { prisma, repository, handle, held } = await heldFixture(original);
			await recoverLabelSyncMutationAttempts(prisma);
			await expect(recoverLabelSyncMutationAttempts(prisma)).resolves.toBe(0);
			const acquired = await repository.acquireReconciliation(handle);
			if (acquired.kind !== "acquired") throw new Error("expected observation claim");
			await expect(
				repository.completeReconciliation({
					...handle,
					snapshot: acquired.snapshot,
					claimToken: acquired.claimToken,
					reconcileAttemptCount: acquired.reconcileAttemptCount,
					outcome: { status: "verified", reasonCode: "applied" },
					lastObservedAt: new Date(),
				}),
			).resolves.toMatchObject({ kind: "applied", status: "reconciled" });
			const terminal = await prisma.labelSyncMutationAttempt.findUniqueOrThrow({
				where: { id: held.id },
			});
			expect(terminal).toMatchObject({
				status: "reconciled",
				reasonCode: "desired_state_observed",
				sendAttemptCount: held.sendAttemptCount,
				requestStartedAt: held.requestStartedAt,
				restoreEvidence: held.restoreEvidence,
				activeOperationKey: null,
				claimToken: null,
			});
			expect(() => parseLabelSyncMutationAttempt(terminal)).not.toThrow();
		},
	);
	it("gives two independent clients only one observation claim", async () => {
		const { prisma, handle } = await heldFixture();
		const peer = client();
		let arrivals = 0;
		let release!: () => void;
		const barrier = new Promise<void>((resolve) => {
			release = resolve;
		});
		function staged(native: PrismaClient) {
			let waited = false;
			return {
				$transaction: (
					work: (tx: unknown) => Promise<unknown>,
					options?: Record<string, unknown>,
				) =>
					native.$transaction(async (tx) => {
						const wrapped = new Proxy(tx, {
							get(target, property) {
								if (property !== "labelSyncMutationAttempt") return Reflect.get(target, property);
								return new Proxy(target.labelSyncMutationAttempt, {
									get(delegate, key) {
										if (key !== "findFirst") return Reflect.get(delegate, key);
										return async (...args: Parameters<typeof delegate.findFirst>) => {
											const result = await delegate.findFirst(...args);
											if (!waited) {
												waited = true;
												if (++arrivals === 2) release();
												await barrier;
											}
											return result;
										};
									},
								});
							},
						});
						return work(wrapped);
					}, options),
			};
		}
		const first = new JellyfinMutationRepository(staged(prisma), {
			databaseProvider: "postgresql",
		});
		const second = new JellyfinMutationRepository(staged(peer), { databaseProvider: "postgresql" });
		const results = await Promise.all([
			first.acquireReconciliation(handle),
			second.acquireReconciliation(handle),
		]);
		expect(arrivals).toBe(2);
		expect(results.filter((result) => result.kind === "acquired")).toHaveLength(1);
		expect(results.filter((result) => result.kind === "already-owned")).toHaveLength(1);
	});
	it("preserves held ownership on unavailable reads and fences parent edits", async () => {
		const { prisma, repository, handle, held, input } = await heldFixture();
		const acquired = await repository.acquireReconciliation(handle);
		if (acquired.kind !== "acquired") throw new Error("expected observation claim");
		await expect(
			repository.completeReconciliation({
				...handle,
				snapshot: acquired.snapshot,
				claimToken: acquired.claimToken,
				reconcileAttemptCount: acquired.reconcileAttemptCount,
				outcome: { status: "unknown", reasonCode: "reconciliation_unavailable" },
				lastObservedAt: new Date(),
			}),
		).resolves.toMatchObject({ kind: "applied", status: "restored-held" });
		await expect(
			repository.guardRuleUpdate({
				userId: input.userId,
				ruleId: input.ruleId,
				data: { name: "changed" },
			}),
		).rejects.toMatchObject({ category: "conflict" });
		await expect(
			repository.deleteDestinationGuarded({
				userId: input.userId,
				destinationInstanceId: input.destinationInstanceId,
			}),
		).rejects.toMatchObject({ category: "conflict" });
		expect(
			await prisma.labelSyncMutationAttempt.findUniqueOrThrow({ where: { id: held.id } }),
		).toMatchObject({
			status: "restored-held",
			activeOperationKey: held.activeOperationKey,
			claimToken: null,
			restoreEvidence: held.restoreEvidence,
		});
	});
	it("rejects a stale completion after a restart gives another worker the claim", async () => {
		const { prisma, repository, handle, held } = await heldFixture();
		const first = await repository.acquireReconciliation(handle);
		if (first.kind !== "acquired") throw new Error("expected observation claim");
		await recoverLabelSyncMutationAttempts(prisma);
		const second = await repository.acquireReconciliation(handle);
		if (second.kind !== "acquired") throw new Error("expected replacement claim");
		await expect(
			repository.completeReconciliation({
				...handle,
				snapshot: first.snapshot,
				claimToken: first.claimToken,
				reconcileAttemptCount: first.reconcileAttemptCount,
				outcome: { status: "verified", reasonCode: "applied" },
				lastObservedAt: new Date(),
			}),
		).resolves.toEqual({ kind: "superseded" });
		expect(
			await prisma.labelSyncMutationAttempt.findUniqueOrThrow({ where: { id: held.id } }),
		).toMatchObject({
			status: "restored-held",
			activeOperationKey: held.activeOperationKey,
			claimToken: second.claimToken,
		});
	});
	it("blocks a restored physical target across independent owners", async () => {
		const first = await heldFixture();
		const alias = await seed();
		await expect(
			alias.repository.claimPhysicalTarget(
				{ ...alias.input, targetItemId: first.input.targetItemId },
				"held-pg-server",
			),
		).resolves.toEqual({ kind: "target-busy" });
		expect(
			await alias.prisma.labelSyncMutationAttempt.count({ where: { userId: alias.input.userId } }),
		).toBe(0);
	});
	it("rolls back startup before any update when restored provenance is future or malformed", async () => {
		const { prisma, repository, input, held } = await heldFixture();
		await repository.claim({ ...input, tmdbId: input.tmdbId + 10000 });
		await prisma.$executeRawUnsafe(
			'UPDATE "label_sync_mutation_attempts" SET "restoreEvidence" = $1 WHERE "id" = $2',
			'{"version":2}',
			held.id,
		);
		const before = await prisma.labelSyncMutationAttempt.findMany({ orderBy: { id: "asc" } });
		await expect(recoverLabelSyncMutationAttempts(prisma)).rejects.toMatchObject({
			category: "dependency-failure",
		});
		expect(await prisma.labelSyncMutationAttempt.findMany({ orderBy: { id: "asc" } })).toEqual(
			before,
		);
	});
});
