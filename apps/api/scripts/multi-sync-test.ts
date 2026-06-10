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
	level: "info",
	child: () => log,
	info: () => {},
	debug: () => {},
	warn: (...args: unknown[]) => console.log("[warn]", ...args),
	error: (...args: unknown[]) => console.log("[error]", ...args),
	trace: () => {},
	fatal: () => {},
	silent: () => {},
};

function mem() {
	const m = process.memoryUsage();
	return {
		heap: Math.round(m.heapUsed / 1024 / 1024),
		rss: Math.round(m.rss / 1024 / 1024),
	};
}

for (const service of ["SONARR", "RADARR", "LIDARR"] as const) {
	const inst = await prisma.serviceInstance.findFirst({
		where: { service, enabled: true },
	});
	if (!inst) {
		console.log(`(skip ${service}: no enabled instance)`);
		continue;
	}

	const before = mem();
	let peak = before.heap;
	const interval = setInterval(() => {
		const m = mem();
		if (m.heap > peak) peak = m.heap;
	}, 50);

	const start = Date.now();
	const res = await syncInstance(
		{ prisma, arrClientFactory, encryptor, log: log as never },
		inst,
	);
	clearInterval(interval);
	const after = mem();
	const wall = Date.now() - start;

	const ok = res.success && !res.error;
	console.log(
		`[${ok ? "OK" : "FAIL"}] ${inst.label.padEnd(16)} (${service.padEnd(7)}) | ` +
			`processed=${String(res.itemsProcessed).padStart(5)} ` +
			`updated=${String(res.itemsUpdated).padStart(5)} ` +
			`added=${String(res.itemsAdded).padStart(3)} ` +
			`removed=${String(res.itemsRemoved).padStart(3)} | ` +
			`heap ${before.heap}->${after.heap}MB peak=${peak}MB (Δ${peak - before.heap}MB) | ` +
			`${wall}ms`,
	);
	if (res.error) console.log(`    error: ${res.error}`);
}

await prisma.$disconnect();
process.exit(0);
