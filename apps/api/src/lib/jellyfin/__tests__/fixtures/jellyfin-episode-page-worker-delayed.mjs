import { parentPort, workerData } from "node:worker_threads";
if (Object.keys(process.env).length || process.execArgv.length) {
	parentPort.postMessage({ status: "failed", category: "invalid-request" });
	parentPort.close();
} else {
	parentPort.postMessage({
		status: "page",
		page: {
			startIndex: workerData.startIndex,
			totalRecordCount: workerData.startIndex + 1,
			items: [{ id: "excluded", type: "Episode", excludedReason: "missing-episode-metadata" }],
		},
	});
	setTimeout(() => parentPort.close(), 150);
}
