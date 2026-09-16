import { execFileSync } from "node:child_process";
import { mkdtempSync, rmSync } from "node:fs";
import { createServer } from "node:http";
import { tmpdir } from "node:os";
import { join } from "node:path";
import pino from "pino";
import { afterEach, describe, expect, it } from "vitest";
import { createTestPrismaClient } from "../../__tests__/test-prisma.js";
import { Encryptor } from "../../auth/encryption.js";
import type { PrismaClient, ServiceInstance } from "../../prisma.js";
import {
	beginNativeInventoryAttempt,
	type NativeInventoryRow,
	publishNativeInventoriesInTransaction,
} from "../../provider-observation/native-inventory.js";
import type { LabelSyncRuleInput } from "../execute-rule.js";
import {
	executeJellyfinMutations,
	reconcileJellyfinMutationAttempts,
} from "../jellyfin-mutation-executor.js";
import { JellyfinMutationRepository } from "../jellyfin-mutation-repository.js";
import { registerLabelSyncMutationAdmission } from "../mutation-admission.js";

const databases: Array<{
	directory: string;
	prisma: PrismaClient;
	closeProvider: () => Promise<void>;
	unregister: () => void;
}> = [];

const SERVER_ID = "fixture-jellyfin-server";
const ADMIN_ID = "fixture-admin";
const LIBRARY_ID = "fixture-library";
const ITEM_ID = "fixture-movie";
const TMDB_ID = 4242;
const NOW = new Date("2026-09-15T12:00:00.000Z");
const encryptor = new Encryptor("01234567890123456789012345678901");
const log = pino({ level: "silent" });

type FixtureDto = {
	Id: string;
	Type: "Movie" | "Series";
	ProviderIds: { Tmdb: string; Imdb: string };
	Tags: string[];
	Name: string;
	ProductionYear: number;
	ImageTags: { Primary: string };
	CustomFixtureField: { preserved: boolean };
};

type ProviderState = {
	item: FixtureDto;
	extraItems: FixtureDto[];
	catalogReads: number;
	assignDuplicateAfterFirstPass?: boolean;
	postBodies: FixtureDto[];
	uncertainPost: boolean;
	pendingBody?: FixtureDto;
	releasePending: () => void;
	requestPaths: string[];
};

function json(response: import("node:http").ServerResponse, status: number, body: unknown) {
	response.statusCode = status;
	response.setHeader("content-type", "application/json");
	response.end(JSON.stringify(body));
}

async function provider(state: ProviderState): Promise<{
	baseUrl: string;
	close: () => Promise<void>;
}> {
	const server = createServer(async (request, response) => {
		const parsed = new URL(request.url ?? "/", "http://fixture.invalid");
		state.requestPaths.push(`${request.method ?? "GET"} ${parsed.pathname}${parsed.search}`);
		if (request.method === "GET" && parsed.pathname === "/Library/MediaFolders") {
			json(response, 200, {
				Items: [
					{
						Id: LIBRARY_ID,
						Name: "Fixture library",
						Type: "CollectionFolder",
						CollectionType: "movies",
					},
				],
				TotalRecordCount: 1,
				StartIndex: 0,
			});
			return;
		}
		if (request.method === "GET" && parsed.pathname === "/Items") {
			state.catalogReads++;
			const items = [state.item, ...state.extraItems];
			const start = Number(parsed.searchParams.get("StartIndex") ?? 0);
			json(response, 200, {
				Items: items.slice(start, start + Number(parsed.searchParams.get("Limit") ?? 1000)),
				TotalRecordCount: items.length,
				StartIndex: start,
			});
			if (state.assignDuplicateAfterFirstPass && state.catalogReads === 1)
				state.extraItems[0]!.ProviderIds.Tmdb = String(TMDB_ID);
			return;
		}

		if (request.method === "GET" && parsed.pathname === "/System/Info") {
			json(response, 200, { Id: SERVER_ID });
			return;
		}
		if (request.method === "GET" && parsed.pathname === "/Users") {
			json(response, 200, [{ Id: ADMIN_ID, Policy: { IsAdministrator: true, IsDisabled: false } }]);
			return;
		}
		if (parsed.pathname === `/Items/${ITEM_ID}/Ancestors` && request.method === "GET") {
			json(response, 200, [{ Id: LIBRARY_ID }]);
			return;
		}
		if (parsed.pathname === `/Items/${ITEM_ID}` && request.method === "GET") {
			json(response, 200, state.item);
			return;
		}
		if (parsed.pathname === `/Items/${ITEM_ID}` && request.method === "POST") {
			const chunks: Buffer[] = [];
			for await (const chunk of request) chunks.push(Buffer.from(chunk));
			const body = JSON.parse(Buffer.concat(chunks).toString("utf8")) as FixtureDto;
			state.postBodies.push(body);
			if (state.uncertainPost) {
				state.pendingBody = body;
				request.socket.destroy();
				return;
			}
			state.item = body;
			response.statusCode = 204;
			response.end();
			return;
		}
		json(response, 404, { error: "not found" });
	});
	await new Promise<void>((resolve) => server.listen(0, "127.0.0.1", resolve));
	const address = server.address();
	if (!address || typeof address === "string") throw new Error("fixture server did not bind");
	return {
		baseUrl: `http://127.0.0.1:${address.port}`,
		close: async () =>
			await new Promise<void>((resolve, reject) =>
				server.close((error) => (error ? reject(error) : resolve())),
			),
	};
}

function initialDto(tags: string[] = ["prior-tag"]): FixtureDto {
	return {
		Id: ITEM_ID,
		Type: "Movie",
		ProviderIds: { Tmdb: String(TMDB_ID), Imdb: "tt0424200" },
		Tags: [...tags],
		Name: "Fixture Movie",
		ProductionYear: 2026,
		ImageTags: { Primary: "keep-this-image" },
		CustomFixtureField: { preserved: true },
	};
}

function row(): NativeInventoryRow {
	return {
		nativeId: ITEM_ID,
		mediaType: "movie",
		libraryIds: [LIBRARY_ID],
		parentNativeId: null,
		seasonNumber: null,
		episodeNumber: null,
		title: "Fixture Movie",
		externalIds: { tmdb: [TMDB_ID] },
	};
}

async function publishCatalog(prisma: PrismaClient, instance: ServiceInstance) {
	const begun = await beginNativeInventoryAttempt(prisma, {
		userId: instance.userId,
		instance,
		domains: ["library"],
		now: NOW,
	});
	if (begun.status !== "acquired") throw new Error("native fixture claim unavailable");
	const published = await prisma.$transaction((tx) =>
		publishNativeInventoriesInTransaction(tx, {
			userId: instance.userId,
			authority: begun.authority,
			attempt: begun.attempt,
			now: NOW,
			snapshots: [{ domain: "library", scopeKeys: [LIBRARY_ID], rows: [row()] }],
		}),
	);
	if (published.status !== "published") throw new Error("native fixture publication superseded");
}

async function createFixture(options: { tags?: string[]; uncertainPost?: boolean } = {}) {
	const directory = mkdtempSync(join(tmpdir(), "jellyfin-mutation-executor-"));
	const dbPath = join(directory, "fixture.db");
	execFileSync("pnpm", ["exec", "prisma", "db", "push", "--schema", "prisma/schema.prisma"], {
		cwd: process.cwd(),
		env: { ...process.env, DATABASE_URL: `file:${dbPath}` },
		stdio: "ignore",
	});
	const state: ProviderState = {
		item: initialDto(options.tags),
		extraItems: [],
		catalogReads: 0,
		postBodies: [],
		uncertainPost: options.uncertainPost ?? false,
		releasePending: () => undefined,
		requestPaths: [],
	};
	state.releasePending = () => {
		if (state.pendingBody) state.item = state.pendingBody;
	};
	const runningProvider = await provider(state);
	const prisma = createTestPrismaClient(dbPath);
	const credentials = encryptor.encrypt("fixture-api-key");
	await prisma.user.create({ data: { id: "fixture-owner", username: "fixture-owner" } });
	const instance = await prisma.serviceInstance.create({
		data: {
			id: "fixture-destination",
			userId: "fixture-owner",
			service: "JELLYFIN",
			label: "Fixture Jellyfin",
			baseUrl: runningProvider.baseUrl,
			encryptedApiKey: credentials.value,
			encryptionIv: credentials.iv,
			identityStatus: "VERIFIED",
			identityKind: "JELLYFIN_SERVER_ID",
			expectedIdentity: SERVER_ID,
			identityVerifiedAt: NOW,
			connectionGeneration: 3,
			identityGeneration: 4,
		},
	});
	const rule = await prisma.labelSyncRule.create({
		data: {
			id: "fixture-rule",
			userId: "fixture-owner",
			name: "Fixture rule",
			sourceService: "radarr",
			sourceInstanceId: null,
			sourceTagName: "source-tag",
			destService: "jellyfin",
			destInstanceId: instance.id,
			destTagName: "managed-tag",
		},
	});
	await publishCatalog(prisma, instance);
	let admitted = true;
	const unregister = registerLabelSyncMutationAdmission(prisma, { isOpen: () => admitted });
	const fixture = {
		prisma,
		instance,
		rule: rule as LabelSyncRuleInput,
		state,
		encryptor,
		setAdmitted: (value: boolean) => {
			admitted = value;
		},
		closeProvider: runningProvider.close,
		unregister,
	};
	databases.push({ directory, prisma, closeProvider: runningProvider.close, unregister });
	return fixture;
}

function execute(
	fixture: Awaited<ReturnType<typeof createFixture>>,
	rule = fixture.rule,
	instance = fixture.instance,
) {
	return executeJellyfinMutations({
		rule,
		destInstance: instance,
		candidates: [{ tmdbId: TMDB_ID, mediaType: "movie", title: "Fixture Movie" }],
		prisma: fixture.prisma,
		encryptor: fixture.encryptor,
		log: log as never,
	});
}

afterEach(async () => {
	for (const fixture of databases.splice(0)) {
		fixture.unregister();
		await fixture.prisma.$disconnect();
		await fixture.closeProvider().catch(() => undefined);
		rmSync(fixture.directory, { recursive: true, force: true });
	}
});

describe("Jellyfin mutation executor against disposable native publication", {
	timeout: 30_000,
}, () => {
	it("round-trips the full DTO and unions the prior tags after provider readback", async () => {
		const fixture = await createFixture();
		await expect(execute(fixture)).resolves.toEqual({
			matchesFound: 1,
			labelsApplied: 1,
			failures: 0,
		});
		expect(fixture.state.postBodies).toEqual([
			{ ...initialDto(), Tags: ["prior-tag", "managed-tag"] },
		]);
		expect(
			fixture.state.requestPaths.filter(
				(path) => path === `GET /Items/${ITEM_ID}?userId=${ADMIN_ID}`,
			),
		).toHaveLength(3);
		expect(
			fixture.state.requestPaths.filter(
				(path) => path === `GET /Items/${ITEM_ID}/Ancestors?userId=${ADMIN_ID}`,
			),
		).toHaveLength(3);
		expect(fixture.state.item).toEqual({ ...initialDto(), Tags: ["prior-tag", "managed-tag"] });
		expect(await fixture.prisma.labelSyncMutationAttempt.findFirst()).toMatchObject({
			status: "verified",
			reasonCode: "applied",
			sendAttemptCount: 1,
		});
	});

	it("blocks a live duplicate introduced after the stored unique catalog", async () => {
		const fixture = await createFixture();
		fixture.state.extraItems.push({ ...initialDto(), Id: "new-duplicate" });
		await expect(execute(fixture)).resolves.toEqual({
			matchesFound: 1,
			labelsApplied: 0,
			failures: 1,
		});
		expect(fixture.state.postBodies).toHaveLength(0);
		expect(await fixture.prisma.labelSyncMutationAttempt.findFirst()).toMatchObject({
			status: "blocked",
			reasonCode: "target_changed",
			sendAttemptCount: 0,
		});
	});

	it("does not hide a duplicate whose identifier appears between live passes", async () => {
		const fixture = await createFixture();
		fixture.state.extraItems.push({
			...initialDto(),
			Id: "new-duplicate",
			ProviderIds: { Tmdb: "", Imdb: "ttduplicate" },
		});
		fixture.state.assignDuplicateAfterFirstPass = true;
		await expect(execute(fixture)).resolves.toEqual({
			matchesFound: 1,
			labelsApplied: 0,
			failures: 1,
		});
		expect(fixture.state.postBodies).toHaveLength(0);
		expect(fixture.state.catalogReads).toBe(3);
	});

	it("records an existing desired tag as a no-op without posting", async () => {
		const fixture = await createFixture({ tags: ["prior-tag", "managed-tag"] });
		await expect(execute(fixture)).resolves.toEqual({
			matchesFound: 1,
			labelsApplied: 0,
			failures: 0,
		});
		expect(fixture.state.postBodies).toHaveLength(0);
		expect(await fixture.prisma.labelSyncMutationAttempt.findFirst()).toMatchObject({
			status: "noop",
			reasonCode: "already_applied",
			sendAttemptCount: 0,
		});
	});

	it("keeps an uncertain delayed send unknown, blocks lifecycle edits, and reconciles read-only", async () => {
		const fixture = await createFixture({ uncertainPost: true });
		await expect(execute(fixture)).resolves.toEqual({
			matchesFound: 1,
			labelsApplied: 0,
			failures: 1,
		});
		expect(fixture.state.postBodies).toHaveLength(1);
		const attempt = await fixture.prisma.labelSyncMutationAttempt.findFirstOrThrow();
		expect(attempt).toMatchObject({ status: "unknown", sendAttemptCount: 1 });
		const repository = new JellyfinMutationRepository(fixture.prisma);
		await expect(
			fixture.prisma.$transaction((tx) =>
				repository.guardDestinationInTransaction(tx, {
					userId: fixture.instance.userId,
					destinationInstanceId: fixture.instance.id,
				}),
			),
		).rejects.toThrow();

		await expect(execute(fixture)).resolves.toEqual({
			matchesFound: 1,
			labelsApplied: 0,
			failures: 1,
		});
		expect(fixture.state.postBodies).toHaveLength(1);
		await expect(
			reconcileJellyfinMutationAttempts({
				prisma: fixture.prisma,
				encryptor: fixture.encryptor,
				log: log as never,
			}),
		).resolves.toMatchObject({ examined: 1, verified: 0, unknown: 1 });
		expect(fixture.state.postBodies).toHaveLength(1);

		fixture.state.releasePending();
		await expect(
			reconcileJellyfinMutationAttempts({
				prisma: fixture.prisma,
				encryptor: fixture.encryptor,
				log: log as never,
			}),
		).resolves.toMatchObject({ examined: 1, verified: 1, unknown: 0 });
		expect(fixture.state.postBodies).toHaveLength(1);
		await expect(
			fixture.prisma.$transaction((tx) =>
				repository.guardDestinationInTransaction(tx, {
					userId: fixture.instance.userId,
					destinationInstanceId: fixture.instance.id,
				}),
			),
		).resolves.toBeUndefined();
	});

	it("preserves tag union for sequential and concurrent alias rules", async () => {
		const fixture = await createFixture();
		const credentials = encryptor.encrypt("fixture-api-key");
		const alias = await fixture.prisma.serviceInstance.create({
			data: {
				id: "fixture-alias",
				userId: fixture.instance.userId,
				service: "JELLYFIN",
				label: "Fixture alias",
				baseUrl: fixture.instance.baseUrl,
				encryptedApiKey: credentials.value,
				encryptionIv: credentials.iv,
				identityStatus: "VERIFIED",
				identityKind: "JELLYFIN_SERVER_ID",
				expectedIdentity: SERVER_ID,
				identityVerifiedAt: NOW,
				connectionGeneration: 3,
				identityGeneration: 4,
			},
		});
		await prismaRule(fixture.prisma, "fixture-rule-a", fixture.instance.id, "alias-a");
		const ruleB = await prismaRule(fixture.prisma, "fixture-rule-b", alias.id, "alias-b");
		await publishCatalog(fixture.prisma, alias);

		const ruleA = (await fixture.prisma.labelSyncRule.findUniqueOrThrow({
			where: { id: "fixture-rule-a" },
		})) as LabelSyncRuleInput;
		const executeAlias = (rule: LabelSyncRuleInput, instance: ServiceInstance) =>
			execute(fixture, rule, instance);
		await expect(executeAlias(ruleA, fixture.instance)).resolves.toEqual({
			matchesFound: 1,
			labelsApplied: 1,
			failures: 0,
		});
		await expect(executeAlias(ruleB as LabelSyncRuleInput, alias)).resolves.toEqual({
			matchesFound: 1,
			labelsApplied: 1,
			failures: 0,
		});
		expect(fixture.state.item.Tags).toEqual(["prior-tag", "alias-a", "alias-b"]);

		fixture.state.item = initialDto();
		await expect(
			Promise.all([
				executeAlias(ruleA, fixture.instance),
				executeAlias(ruleB as LabelSyncRuleInput, alias),
			]),
		).resolves.toEqual([
			{ matchesFound: 1, labelsApplied: 1, failures: 0 },
			{ matchesFound: 1, labelsApplied: 1, failures: 0 },
		]);
		expect(fixture.state.item.Tags).toEqual(["prior-tag", "alias-a", "alias-b"]);
		expect(fixture.state.postBodies).toHaveLength(4);
	});
});

async function prismaRule(
	prisma: PrismaClient,
	id: string,
	destinationInstanceId: string,
	tag: string,
) {
	return await prisma.labelSyncRule.create({
		data: {
			id,
			userId: "fixture-owner",
			name: id,
			sourceService: "radarr",
			sourceTagName: "source-tag",
			destService: "jellyfin",
			destInstanceId: destinationInstanceId,
			destTagName: tag,
		},
	});
}
