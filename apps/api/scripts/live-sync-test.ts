// Live sync test for the rawItems pop-drain fix.
// Calls syncInstance directly against Primary Lidarr (read-only API),
// writes to the cloned test DB. Reports memory before/after/peak.

import { readFileSync } from "node:fs";
import { PrismaBetterSqlite3 } from "@prisma/adapter-better-sqlite3";
import { PrismaClient } from "../src/generated/prisma/client.js";
import { ArrClientFactory } from "../src/lib/arr/client-factory.js";
import { Encryptor } from "../src/lib/auth/encryption.js";
import { syncInstance } from "../src/lib/library-sync/sync-executor.js";

const secrets = JSON.parse(readFileSync("/tmp/test-config/secrets.json", "utf8"));
const encryptor = new Encryptor(secrets.encryptionKey);
const adapter = new PrismaBetterSqlite3({ url: "/tmp/test-config/prod.db" });
const prisma = new PrismaClient({ adapter });
const arrClientFactory = new ArrClientFactory(encryptor);

const log = {
	level: "debug",
	child: () => log,
	info: (...args: unknown[]) => console.log("[info]", ...args),
	debug: (...args: unknown[]) => console.log("[debug]", ...args),
	warn: (...args: unknown[]) => console.log("[warn]", ...args),
	error: (...args: unknown[]) => console.log("[error]", ...args),
	trace: () => {},
	fatal: (...args: unknown[]) => console.log("[fatal]", ...args),
	silent: () => {},
};

const lidarr = await prisma.serviceInstance.findFirst({
	where: { service: "LIDARR", enabled: true },
});
if (!lidarr) {
	console.error("No enabled Lidarr instance found");
	process.exit(1);
}

console.log(`\n=== Live sync test: ${lidarr.label} (${lidarr.baseUrl}) ===`);

function memMB() {
	const m = process.memoryUsage();
	return {
		heapUsed: Math.round(m.heapUsed / 1024 / 1024),
		heapTotal: Math.round(m.heapTotal / 1024 / 1024),
		rss: Math.round(m.rss / 1024 / 1024),
		external: Math.round(m.external / 1024 / 1024),
	};
}

const before = memMB();
console.log(`\nMemory BEFORE:`, before);

let peakHeap = before.heapUsed;
const peakInterval = setInterval(() => {
	const m = memMB();
	if (m.heapUsed > peakHeap) peakHeap = m.heapUsed;
}, 50);

const start = Date.now();
try {
	const result = await syncInstance(
		{ prisma, arrClientFactory, encryptor, log: log as never },
		lidarr,
	);
	clearInterval(peakInterval);
	const after = memMB();
	const wallMs = Date.now() - start;

	console.log(`\n=== Result ===`);
	console.log(`  success:        ${result.success}`);
	console.log(`  itemsProcessed: ${result.itemsProcessed}`);
	console.log(`  itemsAdded:     ${result.itemsAdded}`);
	console.log(`  itemsUpdated:   ${result.itemsUpdated}`);
	console.log(`  itemsRemoved:   ${result.itemsRemoved}`);
	console.log(`  newDownloads:   ${result.newDownloads.length}`);
	console.log(`  durationMs:     ${result.durationMs}`);
	if (result.error) console.log(`  error:          ${result.error}`);

	console.log(`\nMemory AFTER:`, after);
	console.log(`\nDelta (peak shows actual loop pressure):`);
	console.log(
		`  heapUsed:  ${before.heapUsed} -> ${after.heapUsed} MB (peak ${peakHeap} MB, delta ${peakHeap - before.heapUsed} MB)`,
	);
	console.log(`  heapTotal: ${before.heapTotal} -> ${after.heapTotal} MB`);
	console.log(`  rss:       ${before.rss} -> ${after.rss} MB`);
	console.log(`  external:  ${before.external} -> ${after.external} MB`);
	console.log(`\nWall-clock: ${wallMs}ms`);
} catch (err) {
	clearInterval(peakInterval);
	console.error("\nSync threw:", err);
	process.exit(1);
} finally {
	await prisma.$disconnect();
}

process.exit(0);
