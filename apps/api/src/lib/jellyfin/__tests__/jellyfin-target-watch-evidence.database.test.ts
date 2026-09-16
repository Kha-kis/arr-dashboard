import { execFileSync } from "node:child_process";
import { mkdtempSync, rmSync } from "node:fs";
import { createServer, type Server } from "node:http";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterEach, describe, expect, it } from "vitest";
import { createTestPrismaClient } from "../../__tests__/test-prisma.js";
import { Encryptor } from "../../auth/encryption.js";
import type { PrismaClient } from "../../prisma.js";
import {
	beginNativeInventoryAttempt,
	type NativeInventoryRow,
	publishNativeInventoriesInTransaction,
} from "../../provider-observation/native-inventory.js";
import {
	encodeJellyfinLibraryGenerationMetadata,
	fingerprintJellyfinLibraryRows,
} from "../jellyfin-generation-metadata.js";
import {
	readJellyfinTargetWatchEvidence,
	revalidateJellyfinTargetWatchEvidence,
} from "../jellyfin-target-watch-evidence.js";

const OWNER_ID = "watch-evidence-owner";
const INSTANCE_ID = "watch-evidence-jellyfin";
const SERVER_ID = "watch-evidence-server";
const LIBRARY_ID = "watch-evidence-library";
const ITEM_ID = "watch-evidence-item";
const TMDB_ID = 4242;
const NOW = new Date("2026-09-15T12:00:00.000Z");
const encryptor = new Encryptor("01234567890123456789012345678901");
const databases: Array<{ directory: string; prisma: PrismaClient; server: Server }> = [];

function json(response: import("node:http").ServerResponse, body: unknown, status = 200) {
	response.statusCode = status;
	response.setHeader("content-type", "application/json");
	response.end(JSON.stringify(body));
}

async function providerFixture(): Promise<{
	server: Server;
	baseUrl: string;
	methods: string[];
}> {
	const methods: string[] = [];
	const server = createServer((request, response) => {
		const parsed = new URL(request.url ?? "/", "http://jellyfin.fixture");
		methods.push(request.method ?? "");
		if (parsed.pathname === "/System/Info") {
			json(response, { Id: SERVER_ID });
			return;
		}
		if (parsed.pathname === "/Users") {
			json(response, [{ Id: "watch-admin", Policy: { IsAdministrator: true, IsDisabled: false } }]);
			return;
		}
		if (parsed.pathname === `/Users/watch-admin/Items/${ITEM_ID}`) {
			json(response, {
				Id: ITEM_ID,
				Type: "Movie",
				ProviderIds: { Tmdb: String(TMDB_ID) },
				UserData: { Played: true, PlayCount: 4 },
			});
			return;
		}
		if (parsed.pathname === `/Items/${ITEM_ID}/Ancestors`) {
			json(response, [{ Id: LIBRARY_ID }]);
			return;
		}
		json(response, { error: "not found" }, 404);
	});
	await new Promise<void>((resolve) => server.listen(0, "127.0.0.1", resolve));
	const address = server.address();
	if (!address || typeof address === "string") throw new Error("fixture server did not bind");
	return { server, baseUrl: `http://127.0.0.1:${address.port}`, methods };
}

function cacheRow() {
	return {
		id: "watch-cache-row",
		instanceId: INSTANCE_ID,
		tmdbId: TMDB_ID,
		mediaType: "movie",
		libraryId: LIBRARY_ID,
		libraryName: "Fixture Movies",
		title: "Fixture Movie",
		jellyfinId: ITEM_ID,
		lastWatchedAt: NOW,
		watchCount: 3,
		watchedByUsers: '["watch-user"]',
		onDeck: false,
		userRating: null,
		collections: "[]",
		addedAt: NOW,
		thumb: null,
		connectionGeneration: 1,
		identityGeneration: 1,
	} as const;
}

function nativeRow(): NativeInventoryRow {
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

async function database(positiveOnly = false) {
	const directory = mkdtempSync(join(tmpdir(), "jellyfin-target-watch-evidence-"));
	const path = join(directory, "fixture.db");
	execFileSync("pnpm", ["exec", "prisma", "db", "push", "--schema", "prisma/schema.prisma"], {
		cwd: process.cwd(),
		env: { ...process.env, DATABASE_URL: `file:${path}` },
		stdio: "ignore",
	});
	const prisma = createTestPrismaClient(path);
	const provider = await providerFixture();
	databases.push({ directory, prisma, server: provider.server });
	await prisma.user.create({ data: { id: OWNER_ID, username: OWNER_ID } });
	const credentials = encryptor.encrypt("fixture-jellyfin-key");
	const instance = await prisma.serviceInstance.create({
		data: {
			id: INSTANCE_ID,
			userId: OWNER_ID,
			service: "JELLYFIN",
			label: "Fixture Jellyfin",
			baseUrl: provider.baseUrl,
			encryptedApiKey: credentials.value,
			encryptionIv: credentials.iv,
			identityStatus: "VERIFIED",
			identityKind: "JELLYFIN_SERVER_ID",
			expectedIdentity: SERVER_ID,
			identityVerifiedAt: NOW,
			connectionGeneration: 1,
			identityGeneration: 1,
		},
	});
	const row = cacheRow();
	const receiptUnit = {
		scopeKey: `library:${LIBRARY_ID}`,
		expectedRawCount: 1,
		pagesAttempted: 1,
		pagesCompleted: 1,
		rawObserved: 1,
		sourceBindings: 1,
		canonicalEntities: 1,
		acceptedSkips: [],
		fatalCount: 0,
	};
	const generationMetadata = encodeJellyfinLibraryGenerationMetadata({
		version: 1,
		provider: "jellyfin",
		cacheType: "jellyfin",
		publicationLevel: positiveOnly ? "positive-only" : "authoritative",
		completeness: positiveOnly ? "partial" : "complete",
		canonicalizationVersion: 1,
		itemCount: 1,
		connectionGeneration: 1,
		identityGeneration: 1,
		contentFingerprint: fingerprintJellyfinLibraryRows([row]),
		coverageReceipt: {
			version: 2,
			provider: "jellyfin",
			attemptStartedAt: NOW.toISOString(),
			observedAt: NOW.toISOString(),
			evidence: positiveOnly ? "positive-only" : "complete",
			units: [
				{
					...receiptUnit,
					...(positiveOnly ? { expectedRawCount: 2, rawObserved: 2, sourceBindings: 2 } : {}),
				},
			],
			publishedCanonicalEntities: 1,
			domains: ["library-inventory", "mapping", "watch-count", "watch-attribution", "on-deck"].map(
				(domain) => ({
					domain,
					evidence:
						positiveOnly && ["mapping", "watch-count"].includes(domain)
							? ("positive-only" as const)
							: ("complete" as const),
					valueSemantics:
						positiveOnly && ["mapping", "watch-count"].includes(domain)
							? ("lower-bound" as const)
							: ("exact" as const),
					units: [
						{
							...receiptUnit,
							scopeKey: `${domain}:${LIBRARY_ID}`,
							...(positiveOnly && domain === "library-inventory"
								? { expectedRawCount: 2, rawObserved: 2, sourceBindings: 2 }
								: {}),
							...(positiveOnly && domain === "mapping"
								? {
										expectedRawCount: 2,
										rawObserved: 2,
										acceptedSkips: [{ reason: "missing-supported-mapping" as const, count: 1 }],
									}
								: {}),
						},
					],
					publishedCanonicalEntities: 1,
				}),
			),
		},
	});
	await prisma.jellyfinCache.create({ data: row });
	await prisma.cacheRefreshStatus.create({
		data: {
			instanceId: INSTANCE_ID,
			cacheType: "jellyfin",
			lastRefreshedAt: NOW,
			lastResult: "success",
			itemCount: 1,
			generationId: "watch-generation-1",
			generationMetadata,
			lastAttemptAt: NOW,
			lastAttemptResult: "success",
			connectionGeneration: 1,
			identityGeneration: 1,
		},
	});
	const begun = await beginNativeInventoryAttempt(prisma, {
		userId: OWNER_ID,
		instance,
		domains: ["library"],
		now: NOW,
	});
	if (begun.status !== "acquired") throw new Error("native fixture claim unavailable");
	const published = await prisma.$transaction((tx) =>
		publishNativeInventoriesInTransaction(tx, {
			userId: OWNER_ID,
			authority: begun.authority,
			attempt: begun.attempt,
			now: NOW,
			snapshots: [{ domain: "library", scopeKeys: [LIBRARY_ID], rows: [nativeRow()] }],
		}),
	);
	if (published.status !== "published") throw new Error("native fixture publication unavailable");
	return { prisma, provider };
}

afterEach(async () => {
	for (const fixture of databases.splice(0)) {
		await fixture.prisma.$disconnect();
		await new Promise<void>((resolve) => fixture.server.close(() => resolve()));
		rmSync(fixture.directory, { recursive: true, force: true });
	}
});

describe("Jellyfin target-watch evidence on persisted SQLite data", () => {
	it.each([false, true])(
		"reads and live-revalidates persisted evidence (positiveOnly=%s)",
		async (positiveOnly) => {
			const { prisma, provider } = await database(positiveOnly);
			const proof = (
				await readJellyfinTargetWatchEvidence({
					prisma,
					userId: OWNER_ID,
					instanceId: INSTANCE_ID,
					targets: [{ mediaType: "movie", tmdbId: TMDB_ID }],
					now: NOW,
				})
			)[0];
			expect(proof).toMatchObject({
				generationId: "watch-generation-1",
				nativeId: ITEM_ID,
				libraryId: LIBRARY_ID,
				observedValue: 3,
			});
			if (!proof) throw new Error("expected persisted watch proof");
			expect(proof.providerStatus.availability).toBe(positiveOnly ? "partial" : "current");

			await expect(
				revalidateJellyfinTargetWatchEvidence({
					prisma,
					encryptor,
					userId: OWNER_ID,
					instanceId: INSTANCE_ID,
					mediaType: "movie",
					tmdbId: TMDB_ID,
					coordinate: proof.coordinate,
					generationId: proof.generationId,
					threshold: 2,
					now: new Date(NOW.getTime() + 1_000),
				}),
			).resolves.toBe(true);
			expect(provider.methods.every((method) => method === "GET")).toBe(true);
			expect(provider.methods).toHaveLength(4);
		},
		120_000,
	);
});
