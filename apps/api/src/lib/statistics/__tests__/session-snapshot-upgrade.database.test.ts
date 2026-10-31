import { execFileSync } from "node:child_process";
import { mkdtempSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join, resolve } from "node:path";
import Database from "better-sqlite3";
import { afterEach, describe, expect, it } from "vitest";
import { parseSessionSnapshotMeasurement } from "../../../plugins/lib/session-snapshot-measurements.js";
import { createTestPrismaClient } from "../../__tests__/test-prisma.js";
import { Encryptor } from "../../auth/encryption.js";

const temporaryDirectories: string[] = [];
const encryptor = new Encryptor(Buffer.alloc(32, 21).toString("base64"));

function push(schema: string, dbPath: string) {
	execFileSync("pnpm", ["exec", "prisma", "db", "push", "--schema", schema], {
		cwd: process.cwd(),
		env: { ...process.env, DATABASE_URL: `file:${dbPath}` },
		stdio: "pipe",
	});
}

afterEach(() => {
	for (const directory of temporaryDirectories.splice(0)) {
		rmSync(directory, { recursive: true, force: true });
	}
});

describe("SessionSnapshot additive provenance upgrade on disposable SQLite", () => {
	it("preserves legacy bytes, connections and ownership while accepting nullable receipts idempotently", async () => {
		const directory = mkdtempSync(join(tmpdir(), "session-snapshot-upgrade-"));
		temporaryDirectories.push(directory);
		const dbPath = join(directory, "upgrade.db");
		const currentSchemaPath = resolve("prisma/schema.prisma");
		const currentSchema = readFileSync(currentSchemaPath, "utf8");
		// A mechanical copy removes only the newly introduced nullable column.
		// No old-schema Prisma model/client is reused to seed the legacy database.
		const oldSchema = currentSchema.replace(
			/(model SessionSnapshot \{[\s\S]*?)(^\s*measurementJson\s+String\?[^\n]*\n)/m,
			"$1",
		);
		const oldSchemaPath = join(directory, "old.prisma");
		writeFileSync(oldSchemaPath, oldSchema);
		push(oldSchemaPath, dbPath);
		const db = new Database(dbPath);
		db.pragma("foreign_keys = ON");
		try {
			expect(db.pragma("table_info(session_snapshots)")).not.toEqual(
				expect.arrayContaining([expect.objectContaining({ name: "measurementJson" })]),
			);
			for (const [index, service] of ["PLEX", "JELLYFIN", "EMBY"].entries()) {
				const owner = `owner-${index % 2}`;
				db.prepare('INSERT OR IGNORE INTO "User" (id, username, updatedAt) VALUES (?, ?, ?)').run(
					owner,
					`synthetic-${owner}`,
					1_759_276_800_000,
				);
				const key = encryptor.encrypt(`synthetic-key-${index}`);
				const auth = encryptor.encrypt(
					JSON.stringify({ v: 1, username: "synthetic", password: `synthetic-${index}` }),
				);
				db.prepare(`INSERT INTO "ServiceInstance" (id, userId, service, label, baseUrl,
					encryptedApiKey, encryptionIv, encryptedHttpAuthCredentials, httpAuthEncryptionIv,
					enabled, connectionGeneration, updatedAt) VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)`).run(
					`source-${index}`,
					owner,
					service,
					"Same synthetic label",
					`https://synthetic.invalid/${index}`,
					key.value,
					key.iv,
					auth.value,
					auth.iv,
					index === 2 ? 0 : 1,
					index + 4,
					1_759_276_800_000,
				);
				const json = ` [ { "user": "synthetic-${index}", "title": "Same synthetic title", "bandwidth": 0 } ] `;
				db.prepare(`INSERT INTO session_snapshots (id, instanceId, capturedAt, concurrentStreams,
					totalBandwidth, lanBandwidth, wanBandwidth, directPlayCount, transcodeCount, directStreamCount,
					sessionsJson) VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)`).run(
					`legacy-${index}`,
					`source-${index}`,
					1_759_276_800_000 + index,
					index + 1,
					index * 101,
					index * 11,
					index * 13,
					index,
					2 - index,
					1,
					json,
				);
			}
			const before = {
				users: db.prepare('SELECT * FROM "User" ORDER BY id').all(),
				connections: db.prepare('SELECT * FROM "ServiceInstance" ORDER BY id').all(),
				snapshots: db.prepare("SELECT * FROM session_snapshots ORDER BY id").all(),
				foreignKeys: db.pragma("foreign_key_list(session_snapshots)"),
			};
			push(currentSchemaPath, dbPath);
			expect(
				db.pragma("table_info(session_snapshots)"),
				"additive nullable provenance column missing",
			).toEqual(
				expect.arrayContaining([
					expect.objectContaining({ name: "measurementJson", notnull: 0, dflt_value: null }),
				]),
			);
			const assertPreserved = () => {
				expect(db.prepare('SELECT * FROM "User" ORDER BY id').all()).toEqual(before.users);
				expect(db.prepare('SELECT * FROM "ServiceInstance" ORDER BY id').all()).toEqual(
					before.connections,
				);
				const legacy = db
					.prepare("SELECT * FROM session_snapshots WHERE id LIKE 'legacy-%' ORDER BY id")
					.all() as Array<Record<string, unknown>>;
				expect(
					legacy.map(({ measurementJson, ...row }) => {
						expect(measurementJson).toBeNull();
						return row;
					}),
				).toEqual(before.snapshots);
				expect(db.pragma("foreign_key_list(session_snapshots)")).toEqual(before.foreignKeys);
				expect(db.pragma("foreign_key_check")).toEqual([]);
			};
			assertPreserved();
			const prisma = createTestPrismaClient(dbPath);
			try {
				for (const status of ["active", "idle", "failed"] as const) {
					const failed = status === "failed";
					const measurementJson = JSON.stringify({
						version: 1,
						provider: "PLEX",
						status,
						bandwidthBasis: "provider-reported",
						observedSessions: failed ? null : status === "active" ? 1 : 0,
						bandwidth: failed
							? null
							: {
									status: "complete",
									knownTotalKbps: 0,
									measuredSessions: status === "active" ? 1 : 0,
									observedSessions: status === "active" ? 1 : 0,
								},
						methods: failed
							? null
							: {
									directPlayCount: status === "active" ? 1 : 0,
									transcodeCount: 0,
									directStreamCount: 0,
									unknownDecisionCount: 0,
								},
						network: {
							status: failed || status === "active" ? "unavailable" : "complete",
							lanKbps: failed || status === "active" ? null : 0,
							wanKbps: failed || status === "active" ? null : 0,
						},
					});
					await prisma.sessionSnapshot.create({
						data: {
							id: `forward-${status}`,
							instanceId: "source-0",
							concurrentStreams: status === "active" ? 1 : 0,
							sessionsJson:
								status === "active" ? '[{"bandwidth":0,"videoDecision":"direct play"}]' : "[]",
							measurementJson,
						},
					});
					expect(parseSessionSnapshotMeasurement(measurementJson)).toMatchObject({
						status: "verified",
						measurement: { status },
					});
					expect(
						(await prisma.sessionSnapshot.findUniqueOrThrow({ where: { id: `forward-${status}` } }))
							.measurementJson,
					).toBe(measurementJson);
				}
			} finally {
				await prisma.$disconnect();
			}
			const forward = db
				.prepare("SELECT * FROM session_snapshots WHERE id LIKE 'forward-%' ORDER BY id")
				.all();
			push(currentSchemaPath, dbPath);
			assertPreserved();
			expect(
				db.prepare("SELECT * FROM session_snapshots WHERE id LIKE 'forward-%' ORDER BY id").all(),
			).toEqual(forward);
			expect(() =>
				db
					.prepare(
						"INSERT INTO session_snapshots (id, instanceId, concurrentStreams, sessionsJson) VALUES ('orphan', 'absent', 0, '[]')",
					)
					.run(),
			).toThrow(/FOREIGN KEY/);
			for (const row of before.connections as Array<{
				encryptedApiKey: string;
				encryptionIv: string;
			}>) {
				expect(encryptor.decrypt({ value: row.encryptedApiKey, iv: row.encryptionIv })).toMatch(
					/^synthetic-key-[012]$/,
				);
			}
		} finally {
			db.close();
		}
	}, 60_000);
});
