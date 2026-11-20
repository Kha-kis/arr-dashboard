import { parentPort, workerData } from "node:worker_threads";
import Database from "better-sqlite3";
import { acquireSqliteRestoreOperationLock } from "../../restore-runtime-sqlite.js";

// Real physical participant for transport lifetime tests, not a finalizer mock
// represented as provider publication or native application admission evidence.
if (!parentPort || typeof workerData?.databaseUrl !== "string") throw new Error("Fixture binding");
const port = parentPort;
const participation = await acquireSqliteRestoreOperationLock(workerData.databaseUrl);
const database = new Database(workerData.databaseUrl.slice(5), { fileMustExist: true });
database.prepare("SELECT COUNT(*) FROM User").get();
await participation.assertHeld();
let released = false;
port.on("message", async (message) => {
	if (message !== "release" || released) return;
	released = true;
	database.close();
	await participation.close();
	port.close();
});
port.postMessage({
	status: "published",
	itemCount: 0,
	finalizationCallMs: 0,
	outerOverheadMs: 0,
	cleanupMs: 0,
	cleanupFailed: false,
});
