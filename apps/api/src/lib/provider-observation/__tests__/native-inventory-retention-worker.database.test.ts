import { execFile } from "node:child_process";
import { chmodSync, lstatSync, mkdtempSync, readFileSync, rmSync, symlinkSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { setTimeout as delay } from "node:timers/promises";
import { pathToFileURL } from "node:url";
import { promisify } from "node:util";
import Database from "better-sqlite3";
import { expect, it } from "vitest";
import { runNativeInventoryRetentionTick } from "../../../plugins/native-inventory-scheduler.js";
import { openRestoreRuntime, type RestoreRuntime } from "../../backup/restore-runtime-admission.js";
import { createRuntimePrismaClient } from "../../backup/restore-runtime-client.js";
import {
	createNativeInventoryRetentionWorker,
	nativeInventoryRetentionWorkerUrl,
	runNativeInventoryRetentionWorker,
} from "../native-inventory-retention-worker-transport.js";

function removeOwnedFixture(directory: string, owned: { dev: bigint; ino: bigint }) {
	const current = lstatSync(directory, { bigint: true });
	if (current.dev !== owned.dev || current.ino !== owned.ino)
		throw new Error("Synthetic fixture ownership changed");
	rmSync(directory, { recursive: true, force: true });
}

it("refuses real runtime admission without spawning a thread", async () => {
	let spawned = false;
	await expect(
		runNativeInventoryRetentionWorker(
			{
				databaseUrl: "file:/synthetic/nonexistent.db",
				cutoff: new Date("2026-10-01T00:00:00Z"),
				rowLimit: 500,
				scanLimit: 10,
				cursor: null,
			},
			{
				createWorker: () => {
					spawned = true;
					throw new Error("Must not spawn without admission");
				},
			},
		),
	).rejects.toThrow("Native inventory retention worker failed");
	expect(spawned).toBe(false);
});

// Moving the retention call back onto the scheduler thread must fail this real
// timer observation. The trigger models one expensive native SQLite statement;
// neither the retention function nor its Prisma/runtime boundary is mocked.
it.each(["source", "built"])(
	"%s: keeps parent timers moving while guarded SQLite retention executes expensive SQL",
	async (mode) => {
		const directory = mkdtempSync(join(tmpdir(), "native-retention-worker-"));
		chmodSync(directory, 0o700);
		const owned = lstatSync(directory, { bigint: true });
		const path = join(directory, "fixture.db");
		const databaseUrl = `file:${path}`;
		const inspector = new Database(path);
		chmodSync(path, 0o600);
		let runtime: RestoreRuntime | undefined;
		let client: ReturnType<typeof createRuntimePrismaClient> | undefined;
		let timer: ReturnType<typeof setInterval> | undefined;
		let losses = 0;
		try {
			inspector.pragma("journal_mode=WAL");
			const schema = readFileSync(
				new URL("../../../../prisma/runtime-schema/sqlite-v1.sql", import.meta.url),
				"utf8",
			);
			// Registry source includes historical ALTER atoms as well as current CREATE
			// atoms. A fresh disposable fixture needs only the current table/index set.
			for (const atom of schema.split(/-- arr-schema-atom [^\n]+\n/)) {
				if (/^\s*CREATE (?:UNIQUE )?(?:TABLE|INDEX)\b/.test(atom)) inspector.exec(atom);
			}
			runtime = await openRestoreRuntime({
				databaseUrl,
				onUnavailable: () => {
					losses++;
				},
			});
			await runtime.bindDestination("synthetic-destination");
			await runtime.activate();
			client = createRuntimePrismaClient(runtime);
			const prisma = client.prisma;
			await runtime.runOperation(async () => {
				await prisma.user.create({ data: { id: "owner", username: "synthetic-owner" } });
				await prisma.serviceInstance.create({
					data: {
						id: "provider",
						userId: "owner",
						service: "JELLYFIN",
						label: "Synthetic",
						baseUrl: "http://fixture.invalid",
						encryptedApiKey: "synthetic",
						encryptionIv: "synthetic",
						connectionGeneration: 2,
						identityGeneration: 3,
					},
				});
				await prisma.providerNativeInventoryRun.createMany({
					data: [
						{
							id: "obsolete",
							instanceId: "provider",
							workKey: "library",
							state: "incomplete",
							connectionGeneration: 2,
							identityGeneration: 3,
							createdAt: new Date("2026-10-01T00:00:00Z"),
							updatedAt: new Date("2026-10-01T00:00:00Z"),
						},
						{
							id: "latest",
							instanceId: "provider",
							workKey: "library",
							state: "incomplete",
							connectionGeneration: 2,
							identityGeneration: 3,
							createdAt: new Date("2026-10-02T00:00:00Z"),
							updatedAt: new Date("2026-10-02T00:00:00Z"),
						},
					],
				});
			});
			inspector.exec(`CREATE TRIGGER expensive_retention BEFORE DELETE ON provider_native_inventory_runs
			WHEN old.id='obsolete' BEGIN
			SELECT sum(x) FROM (WITH RECURSIVE work(x) AS
			(VALUES(1) UNION ALL SELECT x+1 FROM work WHERE x<3000000) SELECT x FROM work);
			END;`);
			const output = join(directory, "build");
			if (mode === "built") {
				// Compile only this standalone entry, with the production output name.
				// The root still owns the actual package/full candidate build gate.
				await promisify(execFile)(
					process.execPath,
					[
						"--input-type=module",
						"-e",
						`import { build } from "tsup"; await build({ entry: { "lib/provider-observation/native-inventory-retention-worker": "src/lib/provider-observation/native-inventory-retention-worker.ts" }, format: ["esm"], outDir: ${JSON.stringify(output)}, config: false, silent: true });`,
					],
					{
						cwd: process.cwd(),
						env: { PATH: process.env.PATH, LANG: "C.UTF-8", NODE_ENV: "test" },
						timeout: 30_000,
					},
				);
				symlinkSync(join(process.cwd(), "node_modules"), join(output, "node_modules"), "dir");
			}
			let ticks = 0,
				maximumGapMs = 0,
				previous = performance.now();
			timer = setInterval(() => {
				const now = performance.now();
				maximumGapMs = Math.max(maximumGapMs, now - previous);
				previous = now;
				ticks++;
			}, 5);
			await delay(15);
			const started = performance.now();
			await runtime.runOperation(async () => {
				if (mode === "built") {
					const result = await runNativeInventoryRetentionWorker(
						{
							databaseUrl,
							cutoff: new Date("2026-10-20T00:00:00Z"),
							rowLimit: 500,
							scanLimit: 10,
							cursor: null,
						},
						{
							createWorker: (_url, data, transferList) =>
								createNativeInventoryRetentionWorker(
									nativeInventoryRetentionWorkerUrl(
										pathToFileURL(join(output, "chunk-runtime.js")).href,
									),
									data,
									transferList,
								),
						},
					);
					expect(result).toEqual({
						status: "completed",
						deletedRows: 1,
						deletedRuns: 1,
						scannedRuns: 2,
						nextCursor: null,
						hasMore: false,
					});
					return;
				}
				await runNativeInventoryRetentionTick({
					prisma,
					config: { DATABASE_URL: databaseUrl },
					log: { info() {}, error() {} },
				} as never);
			});
			await delay(10);
			const elapsedMs = performance.now() - started;
			clearInterval(timer);
			timer = undefined;
			expect(
				inspector.prepare("SELECT id FROM provider_native_inventory_runs ORDER BY id").all(),
			).toEqual([{ id: "latest" }]);
			expect(losses).toBe(0);
			process.stdout.write(
				`${JSON.stringify({
					category: "synthetic-retention-responsiveness",
					mode,
					elapsedMs: Math.round(elapsedMs),
					maximumGapMs: Math.round(maximumGapMs),
					ticks,
				})}\n`,
			);
			expect(maximumGapMs).toBeLessThan(200);
			expect(ticks).toBeGreaterThan(5);
		} finally {
			if (timer) clearInterval(timer);
			await client?.close();
			await runtime?.close();
			inspector.close();
			removeOwnedFixture(directory, owned);
		}
	},
	40_000,
);
