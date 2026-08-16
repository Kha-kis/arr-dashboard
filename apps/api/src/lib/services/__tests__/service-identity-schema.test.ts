import { execFileSync } from "node:child_process";
import { mkdtempSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join, resolve } from "node:path";
import Database from "better-sqlite3";
import { afterEach, describe, expect, it } from "vitest";
import { formatServiceInstance } from "../service-formatter.js";

const apiRoot = resolve(process.cwd());
const schemaPath = resolve(apiRoot, "prisma/schema.prisma");
const identityEnums = `enum ProviderIdentityKind {
  PLEX_MACHINE_IDENTIFIER @map("plex-machine-identifier")
  JELLYFIN_SERVER_ID      @map("jellyfin-server-id")
  EMBY_SERVER_ID          @map("emby-server-id")
  TAUTULLI_PMS_IDENTIFIER @map("tautulli-pms-identifier")
}

enum ProviderIdentityStatus {
  UNVERIFIED @map("unverified")
  VERIFIED   @map("verified")
  MISMATCH   @map("mismatch")
}

`;
const identityFields = `  // Durable provider-identity state. Lifecycle activation is intentionally deferred.
  expectedIdentity             String?
  identityKind                 ProviderIdentityKind?
  identityStatus               ProviderIdentityStatus @default(UNVERIFIED)
  identityGeneration           Int                    @default(0)
  identityVerifiedAt           DateTime?
  identityLastCheckedAt        DateTime?
`;
const identityIndexes = `  @@index([service, enabled, identityStatus])
`;
const cacheGenerationFields = `  connectionGeneration Int?
  identityGeneration   Int?
`;
const cacheGenerationIndex = `  @@index([instanceId, connectionGeneration, identityGeneration])
`;

const temporaryDirectories: string[] = [];

afterEach(() => {
	for (const directory of temporaryDirectories.splice(0)) {
		rmSync(directory, { recursive: true, force: true });
	}
});

describe("ServiceInstance dormant identity schema", () => {
	it("keeps legacy provider cache rows readable while leaving them without generation authority", () => {
		const schema = readFileSync(schemaPath, "utf8");
		for (const model of [
			"PlexCache",
			"PlexEpisodeCache",
			"JellyfinCache",
			"JellyfinEpisodeCache",
			"TautulliCache",
			"CacheRefreshStatus",
		]) {
			const block = schema.match(new RegExp(`model ${model} \\{[\\s\\S]*?^\\}`, "m"))?.[0];
			expect(block, `${model} model`).toContain(cacheGenerationFields);
			expect(block, `${model} generation index`).toContain(
				"@@index([instanceId, connectionGeneration, identityGeneration])",
			);
		}
	});

	it("preserves legacy Plex cache rows with nullable generation provenance after schema sync", () => {
		const directory = mkdtempSync(join(tmpdir(), "arr-cache-generation-schema-"));
		temporaryDirectories.push(directory);
		const databasePath = join(directory, "cache-generation.db");
		const legacySchemaPath = join(directory, "legacy-schema.prisma");
		writeFileSync(legacySchemaPath, removeCacheGenerationState(readFileSync(schemaPath, "utf8")));
		syncSchema(legacySchemaPath, databasePath);
		insertLegacyInstance(databasePath);
		insertLegacyPlexCache(databasePath);
		syncSchema(schemaPath, databasePath);

		const database = new Database(databasePath, { readonly: true });
		try {
			const cache = database
				.prepare(
					"SELECT instanceId, tmdbId, connectionGeneration, identityGeneration FROM plex_cache WHERE id = ?",
				)
				.get("legacy-plex-cache");
			expect(cache).toEqual({
				instanceId: "legacy-instance",
				tmdbId: 42,
				connectionGeneration: null,
				identityGeneration: null,
			});
		} finally {
			database.close();
		}
	}, 30_000);

	it("preserves a legacy instance as unverified generation zero after schema sync", () => {
		const directory = mkdtempSync(join(tmpdir(), "arr-identity-schema-"));
		temporaryDirectories.push(directory);
		const databasePath = join(directory, "identity.db");
		const legacySchemaPath = join(directory, "legacy-schema.prisma");
		const legacySchema = removeIdentityState(readFileSync(schemaPath, "utf8"));

		writeFileSync(legacySchemaPath, legacySchema);
		syncSchema(legacySchemaPath, databasePath);
		insertLegacyInstance(databasePath);
		syncSchema(schemaPath, databasePath);

		const database = new Database(databasePath, { readonly: true });
		try {
			const identity = database
				.prepare(
					`SELECT expectedIdentity, identityKind, identityStatus, identityGeneration,
						identityVerifiedAt, identityLastCheckedAt
					 FROM ServiceInstance WHERE id = ?`,
				)
				.get("legacy-instance");

			expect(identity).toEqual({
				expectedIdentity: null,
				identityKind: null,
				identityStatus: "unverified",
				identityGeneration: 0,
				identityVerifiedAt: null,
				identityLastCheckedAt: null,
			});
		} finally {
			database.close();
		}
	}, 30_000);

	it("exposes a safe provider identity summary without raw identity or credentials", () => {
		const formatted = formatServiceInstance({
			id: "instance-1",
			service: "PLEX",
			label: "Living Room",
			baseUrl: "http://plex.test",
			externalUrl: null,
			enabled: true,
			isDefault: false,
			createdAt: new Date("2026-08-14T00:00:00.000Z"),
			updatedAt: new Date("2026-08-14T00:00:00.000Z"),
			encryptedApiKey: "ciphertext",
			encryptedHttpAuthCredentials: null,
			httpAuthEncryptionIv: null,
			storageGroupId: null,
			hasLocalFilesystemAccess: false,
			pathPrefix: null,
			expectedIdentity: "plex-machine-123",
			identityKind: "PLEX_MACHINE_IDENTIFIER",
			identityStatus: "VERIFIED",
			identityGeneration: 3,
			identityVerifiedAt: new Date("2026-08-14T01:00:00.000Z"),
			identityLastCheckedAt: new Date("2026-08-14T02:00:00.000Z"),
			tags: [],
		} as never);

		expect(formatted).toMatchObject({
			identity: {
				status: "verified",
				kind: "plex-machine-identifier",
				fingerprint: expect.stringMatching(/^[a-f0-9]{12}$/),
				verifiedAt: new Date("2026-08-14T01:00:00.000Z"),
				lastCheckedAt: new Date("2026-08-14T02:00:00.000Z"),
			},
		});
		const serialized = JSON.stringify(formatted);
		expect(serialized).not.toContain("plex-machine-123");
		expect(serialized).not.toContain("ciphertext");
	});
});

function removeIdentityState(schema: string): string {
	if (!schema.includes(identityEnums)) {
		throw new Error("Provider identity enums are missing from the Prisma schema");
	}
	if (!schema.includes(identityFields)) {
		throw new Error("ServiceInstance identity fields are missing from the Prisma schema");
	}
	if (!schema.includes(identityIndexes)) {
		throw new Error("ServiceInstance identity indexes are missing from the Prisma schema");
	}

	return schema.replace(identityEnums, "").replace(identityFields, "").replace(identityIndexes, "");
}

function removeCacheGenerationState(schema: string): string {
	const fieldCount = schema.split(cacheGenerationFields).length - 1;
	const indexCount = schema.split(cacheGenerationIndex).length - 1;
	if (fieldCount !== 6 || indexCount !== 6) {
		throw new Error(
			"Provider cache generation fields or indexes are missing from the Prisma schema",
		);
	}
	return schema.replaceAll(cacheGenerationFields, "").replaceAll(cacheGenerationIndex, "");
}

function syncSchema(schema: string, databasePath: string): void {
	execFileSync("pnpm", ["exec", "prisma", "db", "push", "--schema", schema], {
		cwd: apiRoot,
		env: { ...process.env, DATABASE_URL: `file:${databasePath}` },
		stdio: "pipe",
	});
}

function insertLegacyInstance(databasePath: string): void {
	const database = new Database(databasePath);
	try {
		database
			.prepare(
				"INSERT INTO User (id, username, createdAt, updatedAt) VALUES (?, ?, CURRENT_TIMESTAMP, CURRENT_TIMESTAMP)",
			)
			.run("legacy-user", "legacy-user");
		database
			.prepare(
				`INSERT INTO ServiceInstance (
					id, userId, service, label, baseUrl, encryptedApiKey, encryptionIv,
					isDefault, enabled, hasLocalFilesystemAccess, connectionGeneration, createdAt, updatedAt
				) VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, CURRENT_TIMESTAMP, CURRENT_TIMESTAMP)`,
			)
			.run(
				"legacy-instance",
				"legacy-user",
				"PLEX",
				"Legacy Plex",
				"http://legacy-plex.test",
				"ciphertext",
				"iv",
				0,
				1,
				0,
				0,
			);
	} finally {
		database.close();
	}
}

function insertLegacyPlexCache(databasePath: string): void {
	const database = new Database(databasePath);
	try {
		database
			.prepare(
				`INSERT INTO plex_cache (
					id, instanceId, tmdbId, mediaType, sectionId, sectionTitle, title,
					watchedByUsers, collections, labels
				) VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?)`,
			)
			.run(
				"legacy-plex-cache",
				"legacy-instance",
				42,
				"movie",
				"1",
				"Movies",
				"Legacy Movie",
				"[]",
				"[]",
				"[]",
			);
	} finally {
		database.close();
	}
}
