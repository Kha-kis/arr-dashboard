import { parentPort, workerData } from "node:worker_threads";
import Database from "better-sqlite3";
import { openRestoreRuntimeWorker } from "../../restore-runtime-admission.js";

if (!parentPort) throw new Error("Synthetic fixture parent missing");
const port = parentPort;
if (workerData.role === "writer") {
	const database = new Database(workerData.path, { timeout: 0, fileMustExist: true });
	const releasePort = workerData.releasePort;
	let releasedByProof = false;
	try {
		if (workerData.contended)
			database.exec("BEGIN IMMEDIATE; UPDATE BusyProbe SET value=99 WHERE id=1");
		await new Promise<void>((resolve) => {
			releasePort.once("message", () => {
				if (!workerData.holdUntilClose) {
					releasedByProof = true;
					resolve();
				}
			});
			port.once("message", () => resolve());
			port.postMessage({ category: "ready", locked: database.inTransaction });
		});
	} finally {
		if (database.inTransaction) database.exec("ROLLBACK");
		database.close();
		releasePort.close();
		port.postMessage({ category: "closed", nativeClosed: !database.open, releasedByProof });
		port.close();
	}
} else {
	const runtime = await openRestoreRuntimeWorker(workerData.binding, workerData.databaseUrl);
	const releasePort = workerData.releasePort;
	let callbackCalls = 0;
	try {
		const request = await new Promise<string>((resolve) => {
			port.once("message", resolve);
			port.postMessage({ category: "ready" });
		});
		if (request === "prove") {
			let accepted = false;
			const started = performance.now();
			try {
				accepted = await runtime.runOperation(() => {
					callbackCalls++;
					// Direct worker-to-writer release requires a successful real proof.
					releasePort.postMessage("release-after-proof");
					return true;
				});
			} catch {
				// Report denial without exporting native errors or adding a fallback.
			}
			port.postMessage({
				category: "operation",
				accepted,
				callbackCalls,
				proofMs: performance.now() - started,
			});
			await new Promise<void>((resolve) => port.once("message", () => resolve()));
		}
	} finally {
		await runtime.close();
		releasePort.close();
		port.postMessage({ category: "closed", runtimeClosed: true });
		port.close();
	}
}
