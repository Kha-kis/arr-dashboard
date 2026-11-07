import {
	restoreBackupResponseSchema,
	restoreStatusResponseSchema,
	type BackupData,
} from "@arr/shared";
import { PrismaPg } from "@prisma/adapter-pg";
import { PrismaBetterSqlite3 } from "@prisma/adapter-better-sqlite3";
import { createHash } from "node:crypto";
import { fork } from "node:child_process";
import { createRequire } from "node:module";
import { fileURLToPath, pathToFileURL } from "node:url";
import { mkdir, readFile, rm, stat, writeFile } from "node:fs/promises";
import { request as httpRequest } from "node:http";
import { join } from "node:path";
import Database from "better-sqlite3";
import { Client } from "pg";
import { afterAll, afterEach, beforeAll, beforeEach, describe, expect, it, vi } from "vitest";
import { publicationCredentialColumns } from "../../lib/backup/__tests__/fixtures/restore-runtime-replacement-actor.js";
import { BackupService } from "../../lib/backup/backup-service.js";
import { decryptBackupData, encryptBackupData } from "../../lib/backup/backup-crypto.js";
import { exportDatabase } from "../../lib/backup/backup-database.js";
import { hashPassword } from "../../lib/auth/password.js";
import {
	bootRestoreHttpFixture,
	createRestoreHttpTemplate,
	fixtureBackupPassword,
	fixtureRestoreEnvelope,
	readRestoreFixtureRows,
	restoreHttpFixtureModes,
} from "./fixtures/backup-restore-http-actor.js";

let template: string;
function launchRecoveryProcess(
	directory: string,
	mode: (typeof restoreHttpFixtureModes)[number],
	crashStage?: string,
) {
	const require = createRequire(import.meta.url);
	const actor = fileURLToPath(new URL("./fixtures/backup-restore-http-actor.ts", import.meta.url));
	const environment: Record<string, string> = {
		LANG: "C.UTF-8",
		TZ: "UTC",
		NODE_ENV: "test",
		CI: "true",
		DOTENV_CONFIG_PATH: "/dev/null",
		TSX_DISABLE_CACHE: "1",
	};
	if (crashStage?.startsWith("writer-close-")) environment.LAUNCHER_MANAGED = "true";
	for (const key of [
		"PATH",
		"LOG_DIR",
		"RESTORE_RUNTIME_TEST_PG_URL",
		"RESTORE_RUNTIME_TEST_PROJECT",
	])
		if (process.env[key]) environment[key] = process.env[key]!;
	const child = fork(
		actor,
		[
			template,
			mode,
			directory,
			crashStage ? "publish" : "recover",
			...(crashStage ? [crashStage] : []),
		],
		{
			cwd: process.cwd(),
			env: environment,
			execArgv: ["--import", pathToFileURL(require.resolve("tsx/esm")).href],
			stdio: ["ignore", "pipe", "pipe", "ipc"],
		},
	);
	let stderr = "";
	child.stderr!.on("data", (bytes) => {
		if (stderr.length < 8192) stderr += String(bytes);
	});
	const closed = new Promise<{ code: number | null; signal: string | null }>((resolve) =>
		child.once("close", (code, signal) => resolve({ code, signal })),
	);
	const ready = new Promise<{ address: string; pid: number }>((resolve, reject) => {
		const timer = setTimeout(
			() => reject(new Error("Fresh recovery actor did not become ready")),
			15000,
		);
		child.once("error", (error) => {
			clearTimeout(timer);
			reject(error);
		});
		child.once("close", (code) => {
			clearTimeout(timer);
			reject(new Error(`Fresh recovery actor exited ${code} before readiness: ${stderr}`));
		});
		child.once("message", (message) => {
			clearTimeout(timer);
			if (
				!message ||
				typeof message !== "object" ||
				!("kind" in message) ||
				message.kind !==
					(crashStage ? "restore-http-publication-ready" : "restore-http-recovery-ready") ||
				!("address" in message) ||
				typeof message.address !== "string" ||
				!("pid" in message) ||
				typeof message.pid !== "number"
			)
				reject(new Error("Bounded fresh-runtime readiness evidence required"));
			else resolve({ address: message.address, pid: message.pid });
		});
	});
	const barrier = crashStage
		? new Promise<unknown>((resolve, reject) => {
				const timer = setTimeout(
					() => reject(new Error("Actual public crash barrier unavailable")),
					15000,
				);
				let line = "";
				child.stdout!.on("data", (bytes) => {
					line += String(bytes);
					if (line.length > 512) {
						clearTimeout(timer);
						reject(new Error("Bounded public crash evidence required"));
					} else if (line.endsWith("\n")) {
						clearTimeout(timer);
						try {
							resolve(JSON.parse(line));
						} catch {
							reject(new Error("Invalid public crash barrier"));
						}
					}
				});
				child.once("close", () => {
					clearTimeout(timer);
					reject(new Error("Publisher exited before crash barrier"));
				});
			})
		: undefined;
	void barrier?.catch(() => {});
	return { child, ready, closed, barrier };
}
function deferred() {
	let resolve!: () => void;
	const promise = new Promise<void>((release) => {
		resolve = release;
	});
	return { promise, resolve };
}

/** Pause timing after a real native INSERT, never fabricate SQL or publication results. */
function holdActualPublication(postgres: boolean) {
	const entered = deferred(),
		released = deferred();
	let native: Database.Database | undefined;
	type Driver = Awaited<ReturnType<PrismaBetterSqlite3["connect"]>>;
	const wrap = <T extends Driver>(driver: T): T => {
		if (!postgres) native = Reflect.get(driver, "client") as Database.Database;
		const start = driver.startTransaction.bind(driver);
		driver.startTransaction = async (...args) => {
			const transaction = await start(...args);
			const query = transaction.queryRaw.bind(transaction);
			const execute = transaction.executeRaw.bind(transaction);
			const pause = async <T>(sql: string, result: T): Promise<T> => {
				if (/^\s*INSERT\s+INTO\s+(?:(?:"[^"\n]+"|`[^`\n]+`)\.)?(?:"User"|`User`)\s/i.test(sql)) {
					entered.resolve();
					await released.promise;
				}
				return result;
			};
			transaction.queryRaw = async (input) => pause(input.sql, await query(input));
			transaction.executeRaw = async (input) => pause(input.sql, await execute(input));
			return transaction;
		};
		return driver;
	};
	if (postgres) {
		const connect = PrismaPg.prototype.connect;
		vi.spyOn(PrismaPg.prototype, "connect").mockImplementation(async function (this: PrismaPg) {
			return wrap(await connect.call(this));
		});
	} else {
		const connect = PrismaBetterSqlite3.prototype.connect;
		vi.spyOn(PrismaBetterSqlite3.prototype, "connect").mockImplementation(async function (
			this: PrismaBetterSqlite3,
		) {
			return wrap(await connect.call(this));
		});
	}
	return { entered: entered.promise, release: released.resolve, physical: () => native };
}

/** Execute the real native COMMIT once, then lose only its acknowledgement. */
function loseActualCommitAcknowledgement(databasePath: string, postgres: boolean) {
	let commits = 0;
	const originalQuery = Client.prototype.query;
	const originalPrepare = Database.prototype.prepare;
	const originalExec = Database.prototype.exec;
	if (postgres) {
		Client.prototype.query = new Proxy(originalQuery, {
			apply(target, receiver: Client, args: unknown[]) {
				const sql =
					typeof args[0] === "string"
						? args[0]
						: args[0] && typeof args[0] === "object"
							? Reflect.get(args[0], "text")
							: undefined;
				if (
					receiver.constructor === Client ||
					typeof sql !== "string" ||
					!/^\s*COMMIT\s*;?\s*$/i.test(sql) ||
					typeof args.at(-1) === "function"
				)
					return Reflect.apply(target, receiver, args);
				return (async () => {
					const before = await Reflect.apply(target, receiver, [
						'SELECT phase FROM "RestoreRuntimeControl"',
					]);
					const result = await Reflect.apply(target, receiver, args);
					if (before.rows[0]?.phase === "restart-required" && commits === 0) {
						commits++;
						throw new Error("Synthetic lost native COMMIT acknowledgement");
					}
					return result;
				})();
			},
		});
	} else {
		const intercept = <T>(main: Database.Database, sql: string, execute: () => T): T => {
			if (main.name !== databasePath || !/^\s*COMMIT\s*;?\s*$/i.test(sql)) return execute();
			const before = Reflect.apply(originalPrepare, main, [
				'SELECT phase FROM "RestoreRuntimeControl"',
			]).get() as { phase: string };
			const result = execute();
			if (before.phase === "restart-required" && commits === 0) {
				commits++;
				throw new Error("Synthetic lost native COMMIT acknowledgement");
			}
			return result;
		};
		Database.prototype.exec = function (sql) {
			return intercept(this, sql, () => Reflect.apply(originalExec, this, [sql]));
		};
		Database.prototype.prepare = function (this: Database.Database, sql: string) {
			const statement = Reflect.apply(originalPrepare, this, [sql]) as Database.Statement;
			if (this.name === databasePath && /^\s*COMMIT\s*;?\s*$/i.test(sql)) {
				const main = this;
				statement.run = new Proxy(statement.run, {
					apply(target, receiver, args) {
						return intercept(main, sql, () => Reflect.apply(target, receiver, args));
					},
				});
			}
			return statement;
		} as typeof Database.prototype.prepare;
	}
	return {
		commits: () => commits,
		restore() {
			Client.prototype.query = originalQuery;
			Database.prototype.prepare = originalPrepare;
			Database.prototype.exec = originalExec;
		},
	};
}

function openRestoreRequest(address: string, cookie: string, envelope: string) {
	let finish!: (result: { status: number; body: string } | null) => void;
	const result = new Promise<{ status: number; body: string } | null>((resolve) => {
		finish = resolve;
	});
	const request = httpRequest(
		address + "/api/backup/restore",
		{
			method: "POST",
			agent: false,
			headers: { cookie, "content-type": "application/json" },
		},
		(response) => {
			let body = "";
			response.setEncoding("utf8");
			response.on("data", (chunk: string) => {
				body += chunk;
			});
			response.once("end", () => finish({ status: response.statusCode ?? 0, body }));
			response.once("error", () => finish(null));
		},
	);
	request.once("error", () => finish(null));
	const closed = new Promise<void>((resolve) => request.once("close", resolve));
	request.end(
		JSON.stringify({
			backupData: Buffer.from(envelope).toString("base64"),
			password: fixtureBackupPassword,
		}),
	);
	return { request, result, closed };
}
beforeAll(async () => {
	template = await createRestoreHttpTemplate();
}, 90000);
afterAll(async () => {
	if (template) await rm(template, { recursive: true, force: true });
});

describe.each(restoreHttpFixtureModes)("public protected Restore with actual %s", (mode) => {
	let fixture: Awaited<ReturnType<typeof bootRestoreHttpFixture>>;
	beforeEach(async () => {
		fixture = await bootRestoreHttpFixture(template, mode);
	});
	afterEach(async () => {
		await fixture?.dispose();
		vi.restoreAllMocks();
		vi.unstubAllEnvs();
	});
	async function post(path: string, payload: unknown) {
		return fixture.app.inject({
			method: "POST",
			url: `/api/backup/${path}`,
			headers: { cookie: fixture.cookie },
			payload: payload as never,
		});
	}
	async function healthy() {
		expect(
			await fixture.app.restoreRuntime.runOperation(() => fixture.app.prisma.user.count()),
		).toBe(1);
		expect(
			(
				await readRestoreFixtureRows(
					fixture,
					'SELECT phase, "activeRestoreId", "lastCommittedRestoreId" FROM "RestoreRuntimeControl"',
				)
			)[0],
		).toEqual({
			phase: "running",
			activeRestoreId: null,
			lastCommittedRestoreId: null,
		});
	}

	it("authenticates before parsing an unauthenticated body beyond the ordinary 1MiB limit", async () => {
		const response = await fixture.app.inject({
			method: "POST",
			url: "/api/backup/restore",
			headers: { "content-type": "application/json" },
			payload: "!".repeat(1024 * 1024 + 1),
		});
		expect(response.statusCode).toBe(401);
		await healthy();
	});
	it("refuses an invalid signed session before malformed-body parsing", async () => {
		const response = await fixture.app.inject({
			method: "POST",
			url: "/api/backup/restore",
			headers: { "content-type": "application/json", cookie: "arr_session=synthetic-invalid" },
			payload: "not-json",
		});
		expect(response.statusCode).toBe(401);
		await healthy();
	});
	it("rejects malformed authorized upload input before maintenance", async () => {
		expect((await post("restore", {})).statusCode).toBe(400);
		await healthy();
	});
	it.each(["missing tag name", "invalid polling interval"])(
		"Phase-C correction rejects authentic invalid record %s before maintenance",
		async (invalid) => {
			const envelope = await fixtureRestoreEnvelope(fixture);
			const backup: BackupData = JSON.parse(
				await decryptBackupData(JSON.parse(envelope), fixtureBackupPassword),
			);
			if (invalid === "missing tag name") backup.data.serviceTags = [{ id: "invalid-tag" }];
			else
				backup.data.librarySyncSettings = [
					{ instanceId: "credential-instance", pollingEnabled: true, pollingIntervalMins: 4 },
				];
			const before = await fixture.app.restoreRuntime.runOperation(() =>
				exportDatabase(fixture.app.prisma),
			);
			const invalidEnvelope = JSON.stringify(
				await encryptBackupData(JSON.stringify(backup), fixtureBackupPassword),
			);
			const response = await post("restore", {
				backupData: Buffer.from(invalidEnvelope).toString("base64"),
				password: fixtureBackupPassword,
			});
			expect(response.statusCode, response.body).toBe(400);
			expect(response.json()).toEqual({
				error: "Restore request rejected",
				category: "invalid-backup",
			});
			await healthy();
			const after = await fixture.app.restoreRuntime.runOperation(() =>
				exportDatabase(fixture.app.prisma),
			);
			expect({ ...after, sessions: [] }).toEqual({ ...before, sessions: [] });
			// Authentication legitimately touches lastAccessedAt, but cannot revoke,
			// replace or change the identity/expiry of this existing session.
			const { lastAccessedAt: beforeAccess, ...beforeSession } = before.sessions[0] as Record<
				string,
				unknown
			>;
			const { lastAccessedAt: afterAccess, ...afterSession } = after.sessions[0] as Record<
				string,
				unknown
			>;
			expect(after.sessions).toHaveLength(1);
			expect(afterSession).toEqual(beforeSession);
			expect(new Date(afterAccess as string).getTime()).toBeGreaterThanOrEqual(
				new Date(beforeAccess as string).getTime(),
			);
			expect(
				await fixture.app.restoreRuntime.runOperation(() => fixture.app.prisma.session.count()),
			).toBe(1);
		},
	);
	it.each(["approval", "scan"] as const)(
		"Phase-C correction repeats inert cleanup %s through fresh HTTP runtime without replay",
		async (kind) => {
			const backup: BackupData = JSON.parse(
				await decryptBackupData(
					JSON.parse(await fixtureRestoreEnvelope(fixture)),
					fixtureBackupPassword,
				),
			);
			const date = new Date("2026-10-09T00:00:00.000Z");
			await fixture.app.restoreRuntime.runOperation(async () => {
				await fixture.app.prisma.libraryCleanupConfig.create({
					data: {
						id: "http-cleanup-config",
						userId: "publication-owner",
						createdAt: date,
						updatedAt: date,
					},
				});
				await fixture.app.prisma.libraryCleanupApproval.create({
					data: {
						id: "http-cleanup-approval",
						configId: "http-cleanup-config",
						instanceId: "credential-instance",
						arrItemId: 7,
						itemType: "movie",
						title: "synthetic",
						matchedRuleId: "synthetic-rule",
						matchedRuleName: "synthetic",
						reason: "synthetic",
						sizeOnDisk: 17n,
						status: kind === "approval" ? "executing" : "executed",
						executionToken: kind === "approval" ? "source-cleanup-worker" : null,
						executionAuditCorrelationId: "synthetic-audit",
						safetySnapshot: '{"positive":true}',
						expiresAt: new Date("2030-01-01"),
						createdAt: date,
					},
				});
				if (kind === "scan")
					await fixture.app.prisma.libraryCleanupMediaServerScan.create({
						data: {
							id: "http-cleanup-scan",
							approvalId: "http-cleanup-approval",
							instanceId: "credential-instance",
							service: "plex",
							mediaType: "movie",
							targetKey: "synthetic-target",
							serverIdentity: "synthetic-server",
							plannedSectionIds: '["section"]',
							status: "triggering",
							executionToken: "source-scan-worker",
							attemptCount: 2,
							completedSectionIds: '["previous-section"]',
							requestStartedAt: date,
							createdAt: date,
							updatedAt: date,
						},
					});
				const data = await exportDatabase(fixture.app.prisma);
				for (const field of [
					"libraryCleanupConfig",
					"libraryCleanupApproval",
					"libraryCleanupMediaServerScan",
				] as const)
					backup.data[field] = data[field];
			});
			const envelope = JSON.stringify(
				await encryptBackupData(JSON.stringify(backup), fixtureBackupPassword),
			);
			const payload = {
				backupData: Buffer.from(envelope).toString("base64"),
				password: fixtureBackupPassword,
			};
			const firstResponse = await post("restore", payload);
			expect(firstResponse.statusCode, firstResponse.body).toBe(200);
			const first = restoreBackupResponseSchema.parse(firstResponse.json());
			expect(first.outcome).toBe("committed");
			const approval = await readRestoreFixtureRows(
				fixture,
				'SELECT * FROM "library_cleanup_approvals"',
			);
			const scan = await readRestoreFixtureRows(
				fixture,
				'SELECT * FROM "library_cleanup_media_server_scans"',
			);
			expect(kind === "approval" ? approval[0] : scan[0]).toMatchObject({
				executionToken: null,
				status: kind === "approval" ? "executing" : "triggering",
			});
			const oldCookie = fixture.cookie,
				directory = fixture.directory;
			await fixture.app.close();
			fixture = await bootRestoreHttpFixture(template, mode, directory);
			expect(
				(
					await fixture.app.inject({
						url: "/api/backup/restore/status",
						headers: { cookie: oldCookie },
					})
				).statusCode,
			).toBe(401);
			const status = await fixture.app.inject({
				url: "/api/backup/restore/status",
				headers: { cookie: fixture.cookie },
			});
			expect(restoreStatusResponseSchema.parse(status.json()).latestCommitted?.restoreId).toBe(
				first.restoreId,
			);
			const secondResponse = await post("restore", payload);
			expect(secondResponse.statusCode, secondResponse.body).toBe(200);
			const second = restoreBackupResponseSchema.parse(secondResponse.json());
			expect(second.outcome).toBe("committed");
			expect(second.restoreId).not.toBe(first.restoreId);
			expect(
				await readRestoreFixtureRows(fixture, 'SELECT * FROM "library_cleanup_approvals"'),
			).toEqual(approval);
			expect(
				await readRestoreFixtureRows(fixture, 'SELECT * FROM "library_cleanup_media_server_scans"'),
			).toEqual(scan);
			expect(await readRestoreFixtureRows(fixture, 'SELECT id FROM "sessions"')).toEqual([]);
		},
	);
	it.each(["not-base64", "Zh==", Buffer.from("{}").toString("base64")])(
		"rejects malformed or unauthenticated encoded envelope %j",
		async (backupData) => {
			expect(
				(await post("restore", { backupData, password: fixtureBackupPassword })).statusCode,
			).toBe(400);
			await healthy();
		},
	);
	it("admits a bounded upload above 1MiB for validation instead of rejecting it with the global parser limit", async () => {
		expect(
			(
				await post("restore", {
					backupData: Buffer.from(" ".repeat(1024 * 1024 + 1)).toString("base64"),
					password: fixtureBackupPassword,
				})
			).statusCode,
		).toBe(400);
		await healthy();
	});
	it.each(["../secrets.json", "backup-1"])(
		"rejects stored path or malformed ID %j before file selection",
		async (id) => {
			expect((await post("restore-from-file", { id })).statusCode).toBe(400);
			await healthy();
		},
	);
	it("refuses a missing stored backup without initializing backup directories", async () => {
		expect(
			(await post("restore-from-file", { id: "a".repeat(24), password: fixtureBackupPassword }))
				.statusCode,
		).toBe(400);
		await expect(stat(join(fixture.directory, "backups"))).rejects.toMatchObject({
			code: "ENOENT",
		});
		await healthy();
	});
	it("refuses a wrong explicit password without publication or session revocation", async () => {
		const envelope = await fixtureRestoreEnvelope(fixture);
		expect(
			(
				await post("restore", {
					backupData: Buffer.from(envelope).toString("base64"),
					password: "synthetic-wrong-password",
				})
			).statusCode,
		).toBe(400);
		await healthy();
		expect(
			await fixture.app.restoreRuntime.runOperation(() => fixture.app.prisma.session.count()),
		).toBe(1);
	});
	it("returns protected positive-only status without exposing runtime ownership", async () => {
		const response = await fixture.app.inject({
			url: "/api/backup/restore/status",
			headers: { cookie: fixture.cookie },
		});
		expect(response.statusCode).toBe(200);
		expect(restoreStatusResponseSchema.parse(response.json())).toEqual({ latestCommitted: null });
	});
	it("does not expose Restore status without authentication", async () => {
		expect((await fixture.app.inject("/api/backup/restore/status")).statusCode).toBe(401);
	});
	it("retains the two-attempt Restore rate limit without touching native publication", async () => {
		for (let attempt = 0; attempt < 2; attempt++)
			expect(
				(
					await post("restore", {
						backupData: Buffer.from("{}").toString("base64"),
						password: fixtureBackupPassword,
					})
				).statusCode,
			).toBe(400);
		expect(
			(
				await post("restore", {
					backupData: Buffer.from("{}").toString("base64"),
					password: fixtureBackupPassword,
				})
			).statusCode,
		).toBe(429);
		await healthy();
	});
	it("returns public verified non-commit and preserves a safety hold created after genuine preparation", async () => {
		const envelope = await fixtureRestoreEnvelope(fixture);
		const prepare = BackupService.prototype.prepareBackupRestore;
		vi.spyOn(BackupService.prototype, "prepareBackupRestore").mockImplementation(async function (
			this: BackupService,
			...args
		) {
			const prepared = await prepare.apply(this, args);
			// Genuine preparation remains unchanged. Only add actual durable state
			// between preparation and publication's execution-time conservation check.
			await fixture.app.prisma.queueCleanerImportReceipt.create({
				data: {
					id: "late-hold",
					instanceId: "credential-instance",
					downloadKey: "b".repeat(64),
					queueId: 8,
					downloadTitle: "synthetic-late",
					connectionFingerprint: `v1:${"c".repeat(64)}`,
					commandFingerprint: `v1:${"d".repeat(64)}`,
					commandId: 43,
					state: "unknown",
					lastAttemptAt: new Date(),
				},
			});
			return prepared;
		});
		const response = await post("restore", {
			backupData: Buffer.from(envelope).toString("base64"),
			password: fixtureBackupPassword,
		});
		expect(response.statusCode, response.body).toBe(409);
		const result = restoreBackupResponseSchema.parse(response.json());
		expect(result).toMatchObject({
			outcome: "not-committed",
			success: false,
			reason: "state-changed",
			restart: "manual-required",
		});
		expect(await readRestoreFixtureRows(fixture, 'SELECT username FROM "User"')).toEqual([
			{ username: "synthetic-old" },
		]);
		expect(
			await readRestoreFixtureRows(
				fixture,
				'SELECT id, state FROM "queue_cleaner_import_receipts" ORDER BY id',
			),
		).toEqual([
			{ id: "credential-receipt", state: "unknown" },
			{ id: "late-hold", state: "unknown" },
		]);
		expect(
			Number(
				(await readRestoreFixtureRows(fixture, 'SELECT COUNT(*) AS count FROM "sessions"'))[0]!
					.count,
			),
		).toBe(1);
		expect(
			(
				await readRestoreFixtureRows(
					fixture,
					'SELECT phase, "activeRestoreId", "lastCommittedRestoreId" FROM "RestoreRuntimeControl"',
				)
			)[0],
		).toEqual({
			phase: "restore-pending",
			activeRestoreId: result.restoreId,
			lastCommittedRestoreId: null,
		});
		await expect(
			fixture.app.restoreRuntime.runOperation(() => fixture.app.prisma.user.count()),
		).rejects.toThrow();
	}, 30000);

	it("reports public lost native COMMIT acknowledgement honestly and confirms only after fresh authenticated recovery", async () => {
		const envelope = await fixtureRestoreEnvelope(fixture);
		const fault = loseActualCommitAcknowledgement(
			join(fixture.directory, "main.db"),
			mode === "postgres",
		);
		const controller = await import("../../lib/backup/restore-http-controller.js");
		const invoke = controller.runRestoreHttpController;
		const completed = deferred();
		let publication: Awaited<ReturnType<typeof invoke>> | undefined;
		vi.spyOn(controller, "runRestoreHttpController").mockImplementation(async (...args) => {
			publication = await invoke(...args);
			completed.resolve();
			return publication;
		});
		const exited = deferred(),
			exits: Array<string | number | null | undefined> = [];
		vi.stubEnv("LAUNCHER_MANAGED", "true");
		vi.spyOn(process, "exit").mockImplementation((code) => {
			exits.push(code);
			exited.resolve();
			return undefined as never;
		});
		let requests = 0;
		fixture.app.server.on("request", (incoming) => {
			if (incoming.method === "POST" && incoming.url === "/api/backup/restore") requests++;
		});
		const address = await fixture.app.listen({ host: "127.0.0.1", port: 0 });
		const client = openRestoreRequest(address, fixture.cookie, envelope);
		try {
			const response = await client.result;
			await completed.promise;
			expect(fault.commits()).toBe(1);
			expect(requests).toBe(1);
			if (mode === "postgres") {
				expect(response?.status, response?.body).toBe(200);
				expect(restoreBackupResponseSchema.parse(JSON.parse(response!.body))).toMatchObject({
					outcome: "committed",
					success: true,
					reason: null,
					restart: "automatic-requested",
				});
				await exited.promise;
				expect(exits).toEqual([42]);
			} else {
				expect(publication).toMatchObject({
					outcome: "unavailable",
					success: false,
					reason: "commit-unknown",
					restart: "manual-required",
				});
				if (response) {
					expect(response.status).toBe(503);
					expect(restoreBackupResponseSchema.parse(JSON.parse(response.body))).toEqual(publication);
				}
				await fixture.app.lifecycle.shutdown();
				expect(exits).toEqual([]);
			}
			// Independent SQL sees the actual durable result, not an HTTP body as
			// its own oracle. No second POST is permitted even when delivery fails.
			expect(await readRestoreFixtureRows(fixture, 'SELECT username FROM "User"')).toEqual([
				{ username: "synthetic-restored" },
			]);
			expect(
				Number(
					(await readRestoreFixtureRows(fixture, 'SELECT COUNT(*) AS count FROM "sessions"'))[0]!
						.count,
				),
			).toBe(0);
			expect(
				(
					await readRestoreFixtureRows(
						fixture,
						'SELECT "lastCommittedRestoreId" FROM "RestoreRuntimeControl"',
					)
				)[0]!.lastCommittedRestoreId,
			).toBe(publication!.restoreId);
			fault.restore();
			const oldCookie = fixture.cookie,
				directory = fixture.directory;
			await fixture.app.close();
			fixture = await bootRestoreHttpFixture(template, mode, directory);
			expect(
				(
					await fixture.app.inject({
						url: "/api/backup/restore/status",
						headers: { cookie: oldCookie },
					})
				).statusCode,
			).toBe(401);
			const status = await fixture.app.inject({
				url: "/api/backup/restore/status",
				headers: { cookie: fixture.cookie },
			});
			expect(status.statusCode).toBe(200);
			expect(restoreStatusResponseSchema.parse(status.json()).latestCommitted?.restoreId).toBe(
				publication!.restoreId,
			);
			expect(requests).toBe(1);
		} finally {
			fault.restore();
			client.request.destroy();
			await client.closed;
			await client.result;
			await fixture.app.lifecycle.shutdown();
		}
	}, 30000);

	it.each(["delivered", "disconnected", "terminal-shutdown"] as const)(
		"joins actual public publication before restart disposition for %s response",
		async (delivery) => {
			const envelope = await fixtureRestoreEnvelope(fixture);
			const barrier = holdActualPublication(mode === "postgres");
			const controller = await import("../../lib/backup/restore-http-controller.js");
			const invoke = controller.runRestoreHttpController;
			const controllerCompleted = deferred();
			let controllerResult: Awaited<ReturnType<typeof invoke>> | undefined;
			// Observe the genuine result without replacing preparation, native
			// publication or lifecycle. Shutdown may close the response socket.
			vi.spyOn(controller, "runRestoreHttpController").mockImplementation(async (...args) => {
				controllerResult = await invoke(...args);
				controllerCompleted.resolve();
				return controllerResult;
			});
			const exited = deferred();
			const exits: Array<string | number | null | undefined> = [];
			// Only process termination is intercepted. Native SQL, HTTP, lifecycle,
			// restart grace and every physical database close remain real.
			vi.stubEnv("LAUNCHER_MANAGED", "true");
			vi.spyOn(process, "exit").mockImplementation((code) => {
				exits.push(code);
				exited.resolve();
				return undefined as never;
			});
			let requests = 0;
			fixture.app.server.on("request", (incoming) => {
				if (incoming.method === "POST" && incoming.url === "/api/backup/restore") requests++;
			});
			const address = await fixture.app.listen({ host: "127.0.0.1", port: 0 });
			const client = openRestoreRequest(address, fixture.cookie, envelope);
			let shutdown: Promise<void> | undefined,
				shutdownSettled = false;
			try {
				await Promise.race([
					barrier.entered,
					client.result.then(() => {
						throw new Error("Actual publication INSERT barrier was not reached");
					}),
				]);
				expect(exits).toEqual([]);
				expect(requests).toBe(1);
				if (mode === "postgres") {
					expect(
						Number(
							(
								await readRestoreFixtureRows(
									fixture,
									"SELECT COUNT(*) AS count FROM pg_locks l JOIN pg_stat_activity a ON a.pid=l.pid WHERE l.locktype='advisory' AND l.database=(SELECT oid FROM pg_database WHERE datname=current_database()) AND l.classid=1095914052::oid AND l.objid=2::oid AND l.objsubid=2 AND l.granted AND l.mode='ExclusiveLock' AND a.state='idle in transaction'",
								)
							)[0]!.count,
						),
					).toBe(1);
				} else {
					expect(barrier.physical()?.open).toBe(true);
					expect(barrier.physical()?.inTransaction).toBe(true);
				}
				expect(
					(
						await readRestoreFixtureRows(
							fixture,
							'SELECT phase, "lastCommittedRestoreId" FROM "RestoreRuntimeControl"',
						)
					)[0],
				).toEqual({ phase: "restore-pending", lastCommittedRestoreId: null });
				expect(await readRestoreFixtureRows(fixture, 'SELECT username FROM "User"')).toEqual([
					{ username: "synthetic-old" },
				]);
				if (delivery === "disconnected") {
					client.request.destroy();
					await client.closed;
					await expect(client.result).resolves.toBeNull();
				} else if (delivery === "terminal-shutdown") {
					shutdown = fixture.app.lifecycle.shutdown().then(() => {
						shutdownSettled = true;
					});
					void shutdown.catch(() => {});
					expect(shutdownSettled).toBe(false);
				}
				expect(exits).toEqual([]);
				barrier.release();
				const response = await client.result;
				if (delivery === "delivered") {
					expect(response?.status, response?.body).toBe(200);
					const result = restoreBackupResponseSchema.parse(JSON.parse(response!.body));
					expect(result).toMatchObject({
						outcome: "committed",
						success: true,
						reason: null,
						restart: "automatic-requested",
					});
				}
				if (shutdown) {
					await shutdown;
					await controllerCompleted.promise;
					expect(shutdownSettled).toBe(true);
					expect(exits).toEqual([]);
					expect(controllerResult).toMatchObject({
						outcome: "committed",
						success: true,
						reason: null,
						restart: "manual-required",
					});
				} else {
					await exited.promise;
					expect(exits).toEqual([42]);
				}
				expect(requests).toBe(1);
				expect(await readRestoreFixtureRows(fixture, 'SELECT username FROM "User"')).toEqual([
					{ username: "synthetic-restored" },
				]);
				expect(
					Number(
						(await readRestoreFixtureRows(fixture, 'SELECT COUNT(*) AS count FROM "sessions"'))[0]!
							.count,
					),
				).toBe(0);
				const journal = (
					await readRestoreFixtureRows(
						fixture,
						'SELECT phase, "activeRestoreId", "lastCommittedRestoreId" FROM "RestoreRuntimeControl"',
					)
				)[0]!;
				expect(journal.phase).toBe("restart-required");
				expect(journal.activeRestoreId).toMatch(/^[a-f0-9-]{36}$/);
				expect(journal.lastCommittedRestoreId).toBe(journal.activeRestoreId);
				if (mode === "postgres")
					expect(
						Number(
							(
								await readRestoreFixtureRows(
									fixture,
									"SELECT COUNT(*) AS count FROM pg_locks WHERE locktype='advisory' AND database=(SELECT oid FROM pg_database WHERE datname=current_database()) AND classid=1095914052::oid AND objid IN (1,2) AND objsubid=2 AND granted",
								)
							)[0]!.count,
						),
					).toBe(0);
				else expect(barrier.physical()?.open).toBe(false);
			} finally {
				barrier.release();
				client.request.destroy();
				await client.closed;
				await client.result;
				await shutdown;
				await fixture.app.lifecycle.shutdown();
			}
		},
		30000,
	);
	it.each(["upload", "stored"] as const)(
		"publishes real %s Restore then requires a fresh session for positive status",
		async (selection) => {
			const envelope = await fixtureRestoreEnvelope(fixture);
			const secrets = await readFile(join(fixture.directory, "secrets.json"));
			let path: string | undefined, before: Awaited<ReturnType<typeof stat>> | undefined;
			if (selection === "stored") {
				await mkdir(join(fixture.directory, "backups", "manual"), {
					recursive: true,
					mode: 0o700,
				});
				path = join(fixture.directory, "backups", "manual", "synthetic-backup.json");
				await writeFile(path, envelope, { mode: 0o600 });
				before = await stat(path);
			}
			const response =
				selection === "upload"
					? await post("restore", {
							backupData: Buffer.from(envelope).toString("base64"),
							password: fixtureBackupPassword,
						})
					: await post("restore-from-file", {
							id: createHash("sha256").update(path!).digest("hex").slice(0, 24),
							password: fixtureBackupPassword,
						});
			expect(response.statusCode, response.body).toBe(200);
			const result = restoreBackupResponseSchema.parse(response.json());
			expect(result).toMatchObject({
				outcome: "committed",
				success: true,
				reason: null,
				restart: "manual-required",
			});
			expect(await readFile(join(fixture.directory, "secrets.json"))).toEqual(secrets);
			if (path) {
				expect(await readFile(path, "utf8")).toBe(envelope);
				const after = await stat(path);
				expect([after.ino, after.size, after.mtimeMs]).toEqual([
					before!.ino,
					before!.size,
					before!.mtimeMs,
				]);
			}
			for (const [table, value, iv, plaintext] of publicationCredentialColumns) {
				const rows = (await readRestoreFixtureRows(
					fixture,
					`SELECT "${value}" AS value, "${iv}" AS iv FROM "${table}"`,
				)) as Array<{ value: string; iv: string }>;
				expect(rows).toHaveLength(1);
				expect(fixture.app.encryptor.decrypt(rows[0]!)).toBe(plaintext);
			}
			expect(
				Number(
					(await readRestoreFixtureRows(fixture, 'SELECT COUNT(*) AS count FROM "sessions"'))[0]!
						.count,
				),
			).toBe(0);
			expect(
				await readRestoreFixtureRows(
					fixture,
					'SELECT id, state FROM "queue_cleaner_import_receipts"',
				),
			).toEqual([{ id: "credential-receipt", state: "unknown" }]);
			const oldCookie = fixture.cookie,
				directory = fixture.directory;
			await fixture.app.close();
			fixture = await bootRestoreHttpFixture(template, mode, directory);
			expect(
				(
					await fixture.app.inject({
						url: "/api/backup/restore/status",
						headers: { cookie: oldCookie },
					})
				).statusCode,
			).toBe(401);
			const status = await fixture.app.inject({
				url: "/api/backup/restore/status",
				headers: { cookie: fixture.cookie },
			});
			expect(status.statusCode).toBe(200);
			expect(restoreStatusResponseSchema.parse(status.json()).latestCommitted).toMatchObject({
				restoreId: result.restoreId,
			});
		},
	);

	it("fresh process can authenticate the restored account and observe only positive status without Restore replay", async () => {
		const stage = (name: string) =>
			process.stdout.write(`[restore-recovery-stage] ${mode} ${name}\n`);
		stage("prepare-start");
		const restoredPassword = "synthetic-restored-login-password";
		await fixture.app.restoreRuntime.runOperation(async () => {
			await fixture.app.prisma.user.update({
				where: { id: "publication-owner" },
				data: { hashedPassword: await hashPassword(restoredPassword) },
			});
		});
		await fixtureRestoreEnvelope(fixture);
		// Disable synthetic integration connections before exporting the snapshot:
		stage("credentials-prepared");
		// real login warm-up must never issue a provider request in this fixture.
		await fixture.app.restoreRuntime.runOperation(() =>
			fixture.app.prisma.serviceInstance.updateMany({ data: { enabled: false } }),
		);
		const { exportDatabase } = await import("../../lib/backup/backup-database.js");
		const { encryptBackupData } = await import("../../lib/backup/backup-crypto.js");
		const data = await fixture.app.restoreRuntime.runOperation(() =>
			exportDatabase(fixture.app.prisma),
		);
		data.users[0]!.username = "synthetic-restored";
		const authenticated = JSON.stringify(
			await encryptBackupData(
				JSON.stringify({
					version: "1.3",
					appVersion: "2.24.2",
					timestamp: "2026-10-09T00:00:00.000Z",
					data,
					secrets: {
						encryptionKey: "64".repeat(32),
						sessionCookieSecret: "synthetic-source-cookie",
					},
				}),
				fixtureBackupPassword,
			),
		);
		const oldCookie = fixture.cookie;
		const secrets = await readFile(join(fixture.directory, "secrets.json"));
		stage("envelope-ready");
		const response = await post("restore", {
			backupData: Buffer.from(authenticated).toString("base64"),
			password: fixtureBackupPassword,
		});
		expect(response.statusCode, response.body).toBe(200);
		const published = restoreBackupResponseSchema.parse(response.json());
		expect(published.outcome).toBe("committed");
		stage("published");
		expect(
			Number(
				(await readRestoreFixtureRows(fixture, 'SELECT COUNT(*) AS count FROM "sessions"'))[0]!
					.count,
			),
		).toBe(0);
		await fixture.app.close();
		const actor = launchRecoveryProcess(fixture.directory, mode);
		stage("parent-closed");
		try {
			const { address, pid } = await actor.ready;
			stage("child-ready");
			expect(pid).toBe(actor.child.pid);
			expect(pid).not.toBe(process.pid);
			const url = new URL(address);
			expect(url.hostname).toBe("127.0.0.1");
			expect(
				(
					await fetch(address + "/api/backup/restore/status", {
						headers: { cookie: oldCookie },
						signal: AbortSignal.timeout(10000),
					})
				).status,
			).toBe(401);
			stage("old-session-rejected");
			expect(
				Number(
					(await readRestoreFixtureRows(fixture, 'SELECT COUNT(*) AS count FROM "sessions"'))[0]!
						.count,
				),
			).toBe(0);
			const oldLogin = await fetch(address + "/auth/login", {
				signal: AbortSignal.timeout(10000),
				method: "POST",
				headers: { "content-type": "application/json" },
				body: JSON.stringify({ username: "synthetic-old", password: restoredPassword }),
			});
			expect(oldLogin.status).toBe(401);
			stage("old-account-rejected");
			const login = await fetch(address + "/auth/login", {
				signal: AbortSignal.timeout(10000),
				method: "POST",
				headers: { "content-type": "application/json" },
				body: JSON.stringify({ username: "synthetic-restored", password: restoredPassword }),
			});
			expect(login.status).toBe(200);
			stage("restored-account-authenticated");
			const cookie = login.headers.get("set-cookie")?.split(";")[0];
			expect(cookie).toMatch(/^arr_session=/);
			const status = await fetch(address + "/api/backup/restore/status", {
				signal: AbortSignal.timeout(10000),
				headers: { cookie: cookie! },
			});
			expect(status.status).toBe(200);
			expect(
				restoreStatusResponseSchema.parse(await status.json()).latestCommitted?.restoreId,
			).toBe(published.restoreId);
			expect(await readFile(join(fixture.directory, "secrets.json"))).toEqual(secrets);
			stage("positive-status-verified");
			const stopped = new Promise<unknown>((resolve, reject) => {
				const timer = setTimeout(
					() => reject(new Error("Fresh recovery actor stop acknowledgement unavailable")),
					10000,
				);
				actor.child.once("message", (message) => {
					clearTimeout(timer);
					resolve(message);
				});
				actor.child.once("close", () => {
					clearTimeout(timer);
					reject(new Error("Recovery actor exited before stop acknowledgement"));
				});
			});
			actor.child.send({ kind: "stop" });
			expect(await stopped).toEqual({ kind: "restore-http-recovery-stopped", restorePosts: 0 });
			expect(await actor.closed).toEqual({ code: 0, signal: null });
			stage("child-closed");
		} finally {
			if (actor.child.exitCode === null && actor.child.signalCode === null)
				actor.child.kill("SIGKILL");
			await actor.closed;
		}
	}, 60000);

	it.each(["writer-close-throw", "writer-close-false-ack"] as const)(
		"public physical-close %s retains exclusion and requires joined process-stop recovery",
		async (closeStage) => {
			const password = "synthetic-close-recovery-password";
			await fixtureRestoreEnvelope(fixture);
			await fixture.app.restoreRuntime.runOperation(async () => {
				await fixture.app.prisma.user.update({
					where: { id: "publication-owner" },
					data: { hashedPassword: await hashPassword(password) },
				});
				await fixture.app.prisma.serviceInstance.updateMany({ data: { enabled: false } });
			});
			const { exportDatabase } = await import("../../lib/backup/backup-database.js");
			const { encryptBackupData } = await import("../../lib/backup/backup-crypto.js");
			const data = await fixture.app.restoreRuntime.runOperation(() =>
				exportDatabase(fixture.app.prisma),
			);
			data.users[0]!.username = "synthetic-restored";
			const envelope = JSON.stringify(
				await encryptBackupData(
					JSON.stringify({
						version: "1.3",
						appVersion: "2.24.2",
						timestamp: "2026-10-09T00:00:00.000Z",
						data,
						secrets: {
							encryptionKey: "64".repeat(32),
							sessionCookieSecret: "synthetic-source-cookie",
						},
					}),
					fixtureBackupPassword,
				),
			);
			const secrets = await readFile(join(fixture.directory, "secrets.json"));
			const oldCookie = fixture.cookie;
			const databaseUrl = fixture.app.config.DATABASE_URL;
			if (!databaseUrl) throw new Error("Owned fixture database URL required");
			await fixture.app.close();
			const publisher = launchRecoveryProcess(fixture.directory, mode, closeStage);
			let client: ReturnType<typeof openRestoreRequest> | undefined;
			const pendingPhysicalEnd = mode === "postgres" && closeStage === "writer-close-false-ack";
			try {
				const { address, pid } = await publisher.ready;
				expect(new URL(address).hostname).toBe("127.0.0.1");
				client = openRestoreRequest(address, oldCookie, envelope);
				expect(await publisher.barrier).toEqual({
					kind: "public-restore-close-barrier",
					stage: closeStage,
					pid,
					restorePosts: 1,
				});
				if (pendingPhysicalEnd) {
					// Losing the socket cannot settle a writer whose native end never happened.
					client.request.destroy();
					await client.closed;
					expect(await client.result).toBeNull();
				} else {
					const response = await client.result;
					expect(response?.status, response?.body).toBe(503);
					expect(restoreBackupResponseSchema.parse(JSON.parse(response!.body))).toMatchObject({
						outcome: "unavailable",
						success: false,
						reason: "closure-unverified",
						restart: "manual-required",
					});
				}
				const inspect = new Promise<unknown>((resolve, reject) => {
					const timer = setTimeout(
						() => reject(new Error("Physical-close inspection unavailable")),
						10000,
					);
					publisher.child.once("message", (message) => {
						clearTimeout(timer);
						resolve(message);
					});
					publisher.child.once("close", () => {
						clearTimeout(timer);
						reject(new Error("Publisher exited before physical-close inspection"));
					});
				});
				publisher.child.send({ kind: "inspect-close" });
				expect(await inspect).toEqual({
					kind: "public-restore-close-inspection",
					restorePosts: 1,
					restartRequests: 0,
					responsesFinished: pendingPhysicalEnd ? 0 : 1,
					ordinaryRefused: true,
					shutdownSettled: !pendingPhysicalEnd,
					shutdownRefused: !pendingPhysicalEnd,
				});
				if (mode === "postgres") {
					const { acquirePostgresRestoreRuntimeOwnership } = await import(
						"../../lib/backup/restore-runtime-postgres.js"
					);
					await expect(acquirePostgresRestoreRuntimeOwnership(databaseUrl)).rejects.toThrow();
					expect(
						Number(
							(
								await readRestoreFixtureRows(
									fixture,
									"SELECT COUNT(*) AS count FROM pg_locks WHERE locktype='advisory' AND database=(SELECT oid FROM pg_database WHERE datname=current_database()) AND classid=1095914052::oid AND objid=2::oid AND objsubid=2 AND granted AND mode='ExclusiveLock'",
								)
							)[0]!.count,
						),
					).toBe(1);
				} else {
					const { acquireSqliteRestoreRuntimeOwnership } = await import(
						"../../lib/backup/restore-runtime-sqlite.js"
					);
					await expect(acquireSqliteRestoreRuntimeOwnership(databaseUrl)).rejects.toThrow();
				}
				const control = (
					await readRestoreFixtureRows(
						fixture,
						'SELECT phase, "lastCommittedRestoreId" FROM "RestoreRuntimeControl"',
					)
				)[0]!;
				expect(control.phase).toBe("restart-required");
				expect(control.lastCommittedRestoreId).toMatch(/^[a-f0-9-]{36}$/);
				expect(await readRestoreFixtureRows(fixture, 'SELECT username FROM "User"')).toEqual([
					{ username: "synthetic-restored" },
				]);
				expect(await readRestoreFixtureRows(fixture, 'SELECT id FROM "sessions"')).toEqual([]);
				expect(
					await readRestoreFixtureRows(
						fixture,
						'SELECT id, state, "commandId" FROM "queue_cleaner_import_receipts"',
					),
				).toEqual([{ id: "credential-receipt", state: "unknown", commandId: 42 }]);
				expect(
					await readRestoreFixtureRows(
						fixture,
						'SELECT id, "activeOperationId" FROM "arr_import_source_claims"',
					),
				).toEqual([{ id: "credential-claim", activeOperationId: "credential-operation" }]);
				for (const [table, value, iv, plaintext] of publicationCredentialColumns) {
					const rows = (await readRestoreFixtureRows(
						fixture,
						`SELECT "${value}" AS value, "${iv}" AS iv FROM "${table}"`,
					)) as Array<{ value: string; iv: string }>;
					expect(rows).toHaveLength(1);
					expect(fixture.app.encryptor.decrypt(rows[0]!)).toBe(plaintext);
				}
				publisher.child.kill("SIGKILL");
				expect(await publisher.closed).toEqual({ code: null, signal: "SIGKILL" });
				const recovery = launchRecoveryProcess(fixture.directory, mode);
				try {
					const { address: recoveredAddress } = await recovery.ready;
					expect(
						(
							await fetch(recoveredAddress + "/api/backup/restore/status", {
								headers: { cookie: oldCookie },
								signal: AbortSignal.timeout(10000),
							})
						).status,
					).toBe(401);
					const login = await fetch(recoveredAddress + "/auth/login", {
						method: "POST",
						headers: { "content-type": "application/json" },
						body: JSON.stringify({ username: "synthetic-restored", password }),
						signal: AbortSignal.timeout(10000),
					});
					expect(login.status).toBe(200);
					const cookie = login.headers.get("set-cookie")?.split(";")[0];
					expect(cookie).toMatch(/^arr_session=/);
					const status = await fetch(recoveredAddress + "/api/backup/restore/status", {
						headers: { cookie: cookie! },
						signal: AbortSignal.timeout(10000),
					});
					expect(status.status).toBe(200);
					expect(
						restoreStatusResponseSchema.parse(await status.json()).latestCommitted?.restoreId,
					).toBe(control.lastCommittedRestoreId);
					expect(await readFile(join(fixture.directory, "secrets.json"))).toEqual(secrets);
					const stopped = new Promise<unknown>((resolve, reject) => {
						const timer = setTimeout(() => reject(new Error("Recovery stop unavailable")), 10000);
						recovery.child.once("message", (message) => {
							clearTimeout(timer);
							resolve(message);
						});
						recovery.child.once("close", () => {
							clearTimeout(timer);
							reject(new Error("Recovery exited before stop acknowledgement"));
						});
					});
					recovery.child.send({ kind: "stop" });
					expect(await stopped).toEqual({ kind: "restore-http-recovery-stopped", restorePosts: 0 });
					expect(await recovery.closed).toEqual({ code: 0, signal: null });
				} finally {
					if (recovery.child.exitCode === null && recovery.child.signalCode === null)
						recovery.child.kill("SIGKILL");
					await recovery.closed;
				}
			} finally {
				if (publisher.child.exitCode === null && publisher.child.signalCode === null)
					publisher.child.kill("SIGKILL");
				await publisher.closed;
				client?.request.destroy();
				await client?.closed;
				await client?.result;
			}
		},
		60000,
	);
	it.each([
		["crash-before-pending", "running", false],
		["crash-after-pending", "restore-pending", false],
		["crash-before-commit", "restore-pending", false],
		["crash-after-commit", "restart-required", true],
	] as const)(
		"public crash %s preserves atomic data, holds and fresh authenticated recovery without replay",
		async (crashStage, phase, committed) => {
			const password = "synthetic-crash-recovery-password";
			await fixtureRestoreEnvelope(fixture);
			await fixture.app.restoreRuntime.runOperation(async () => {
				await fixture.app.prisma.user.update({
					where: { id: "publication-owner" },
					data: { hashedPassword: await hashPassword(password) },
				});
				await fixture.app.prisma.serviceInstance.updateMany({ data: { enabled: false } });
			});
			const { exportDatabase } = await import("../../lib/backup/backup-database.js");
			const { encryptBackupData } = await import("../../lib/backup/backup-crypto.js");
			const data = await fixture.app.restoreRuntime.runOperation(() =>
				exportDatabase(fixture.app.prisma),
			);
			data.users[0]!.username = "synthetic-restored";
			const envelope = JSON.stringify(
				await encryptBackupData(
					JSON.stringify({
						version: "1.3",
						appVersion: "2.24.2",
						timestamp: "2026-10-09T00:00:00.000Z",
						data,
						secrets: {
							encryptionKey: "64".repeat(32),
							sessionCookieSecret: "synthetic-source-cookie",
						},
					}),
					fixtureBackupPassword,
				),
			);
			const tables = [
				"User",
				"ServiceInstance",
				"sessions",
				"queue_cleaner_import_receipts",
				"arr_import_operations",
				"arr_import_source_claims",
				"arr_import_file_proofs",
			];
			const snapshot = async () =>
				Object.fromEntries(
					await Promise.all(
						tables.map(async (table) => [
							table,
							await readRestoreFixtureRows(fixture, `SELECT * FROM "${table}"`),
						]),
					),
				);
			const before = await snapshot();
			const secrets = await readFile(join(fixture.directory, "secrets.json"));
			const storage = mode === "postgres" ? null : await stat(join(fixture.directory, "main.db"));
			const oldCookie = fixture.cookie;
			await fixture.app.close();
			const publisher = launchRecoveryProcess(fixture.directory, mode, crashStage);
			let client: ReturnType<typeof openRestoreRequest> | undefined;
			try {
				const { address, pid } = await publisher.ready;
				expect(new URL(address).hostname).toBe("127.0.0.1");
				client = openRestoreRequest(address, oldCookie, envelope);
				expect(await publisher.barrier).toEqual({
					kind: "public-restore-crash-barrier",
					stage: crashStage,
					pid,
					restorePosts: 1,
				});
				const databaseUrl = fixture.app.config.DATABASE_URL;
				if (!databaseUrl) throw new Error("Owned fixture database URL required");
				if (mode === "postgres") {
					const { acquirePostgresRestoreRuntimeOwnership } = await import(
						"../../lib/backup/restore-runtime-postgres.js"
					);
					await expect(acquirePostgresRestoreRuntimeOwnership(databaseUrl)).rejects.toThrow();
				} else {
					const { acquireSqliteRestoreRuntimeOwnership } = await import(
						"../../lib/backup/restore-runtime-sqlite.js"
					);
					await expect(acquireSqliteRestoreRuntimeOwnership(databaseUrl)).rejects.toThrow();
				}
				publisher.child.kill("SIGKILL");
				expect(await publisher.closed).toEqual({ code: null, signal: "SIGKILL" });
				expect(await client.result).toBeNull();
				await client.closed;
				const control = (
					await readRestoreFixtureRows(
						fixture,
						'SELECT phase, "lastCommittedRestoreId" FROM "RestoreRuntimeControl"',
					)
				)[0]!;
				expect(control.phase).toBe(phase);
				const afterCrash = await snapshot();
				if (!committed) {
					const beforeSessions = before.sessions as Array<Record<string, unknown>>;
					const afterSessions = afterCrash.sessions as Array<Record<string, unknown>>;
					expect(beforeSessions).toHaveLength(1);
					expect(afterSessions).toHaveLength(1);
					const previousAccess = new Date(String(beforeSessions[0]!.lastAccessedAt)).getTime();
					const currentAccess = new Date(String(afterSessions[0]!.lastAccessedAt)).getTime();
					expect(Number.isFinite(previousAccess)).toBe(true);
					expect(Number.isFinite(currentAccess)).toBe(true);
					expect(currentAccess).toBeGreaterThanOrEqual(previousAccess);
					expect(currentAccess).toBeLessThanOrEqual(Date.now());
					// Real protected HTTP admission records session activity before publication.
					// Only that metadata may differ; every other row and session field is conserved.
					const withoutAccess = (rows: Array<Record<string, unknown>>) =>
						rows.map(({ lastAccessedAt: _access, ...row }) => row);
					expect({ ...afterCrash, sessions: withoutAccess(afterSessions) }).toEqual({
						...before,
						sessions: withoutAccess(beforeSessions),
					});
				}
				expect(await readRestoreFixtureRows(fixture, 'SELECT username FROM "User"')).toEqual([
					{ username: committed ? "synthetic-restored" : "synthetic-old" },
				]);
				expect(
					Number(
						(await readRestoreFixtureRows(fixture, 'SELECT COUNT(*) AS count FROM "sessions"'))[0]!
							.count,
					),
				).toBe(committed ? 0 : 1);
				expect(
					await readRestoreFixtureRows(
						fixture,
						'SELECT id, state, "commandId" FROM "queue_cleaner_import_receipts"',
					),
				).toEqual([{ id: "credential-receipt", state: "unknown", commandId: 42 }]);
				expect(
					await readRestoreFixtureRows(
						fixture,
						'SELECT id, "activeOperationId" FROM "arr_import_source_claims"',
					),
				).toEqual([{ id: "credential-claim", activeOperationId: "credential-operation" }]);
				for (const [table, value, iv, plaintext] of publicationCredentialColumns) {
					const rows = (await readRestoreFixtureRows(
						fixture,
						`SELECT "${value}" AS value, "${iv}" AS iv FROM "${table}"`,
					)) as Array<{ value: string; iv: string }>;
					expect(rows).toHaveLength(1);
					expect(fixture.app.encryptor.decrypt(rows[0]!)).toBe(plaintext);
				}
				const recovery = launchRecoveryProcess(fixture.directory, mode);
				try {
					const { address: recoveredAddress } = await recovery.ready;
					expect(await snapshot()).toEqual(afterCrash);
					const oldStatus = await fetch(recoveredAddress + "/api/backup/restore/status", {
						headers: { cookie: oldCookie },
						signal: AbortSignal.timeout(10000),
					});
					expect(oldStatus.status).toBe(committed ? 401 : 200);
					const login = await fetch(recoveredAddress + "/auth/login", {
						method: "POST",
						headers: { "content-type": "application/json" },
						body: JSON.stringify({
							username: committed ? "synthetic-restored" : "synthetic-old",
							password,
						}),
						signal: AbortSignal.timeout(10000),
					});
					expect(login.status).toBe(200);
					const cookie = login.headers.get("set-cookie")?.split(";")[0];
					expect(cookie).toMatch(/^arr_session=/);
					const status = await fetch(recoveredAddress + "/api/backup/restore/status", {
						headers: { cookie: cookie! },
						signal: AbortSignal.timeout(10000),
					});
					expect(status.status).toBe(200);
					const positive = restoreStatusResponseSchema.parse(await status.json()).latestCommitted;
					if (committed) {
						expect(positive?.restoreId).toBe(control.lastCommittedRestoreId);
						expect(positive).not.toBeNull();
					} else expect(positive).toBeNull();
					expect(await readFile(join(fixture.directory, "secrets.json"))).toEqual(secrets);
					if (storage) {
						const current = await stat(join(fixture.directory, "main.db"));
						expect([current.dev, current.ino]).toEqual([storage.dev, storage.ino]);
					}
					const stopped = new Promise<unknown>((resolve, reject) => {
						const timer = setTimeout(
							() => reject(new Error("Recovered actor stop acknowledgement unavailable")),
							10000,
						);
						recovery.child.once("message", (message) => {
							clearTimeout(timer);
							resolve(message);
						});
						recovery.child.once("close", () => {
							clearTimeout(timer);
							reject(new Error("Recovered actor exited before stop acknowledgement"));
						});
					});
					recovery.child.send({ kind: "stop" });
					expect(await stopped).toEqual({ kind: "restore-http-recovery-stopped", restorePosts: 0 });
					expect(await recovery.closed).toEqual({ code: 0, signal: null });
				} finally {
					if (recovery.child.exitCode === null && recovery.child.signalCode === null)
						recovery.child.kill("SIGKILL");
					await recovery.closed;
				}
			} finally {
				if (publisher.child.exitCode === null && publisher.child.signalCode === null)
					publisher.child.kill("SIGKILL");
				await publisher.closed;
				client?.request.destroy();
				if (client) {
					await client.closed;
					await client.result;
				}
			}
		},
		60000,
	);
});
