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

const temporaryDirectories: string[] = [];

afterEach(() => {
	for (const directory of temporaryDirectories.splice(0)) {
		rmSync(directory, { recursive: true, force: true });
	}
});

describe("ServiceInstance dormant identity schema", () => {
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

	it("keeps dormant identity state out of formatted service responses", () => {
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
			tags: [],
		});

		expect(JSON.stringify(formatted)).toBe(
			'{"id":"instance-1","service":"plex","label":"Living Room","baseUrl":"http://plex.test","externalUrl":null,"enabled":true,"isDefault":false,"createdAt":"2026-08-14T00:00:00.000Z","updatedAt":"2026-08-14T00:00:00.000Z","hasApiKey":true,"hasHttpAuth":false,"storageGroupId":null,"hasLocalFilesystemAccess":false,"pathPrefix":null,"tags":[]}',
		);
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
