import { parentPort, workerData } from "node:worker_threads";
import { startFinalizerLoopObservation } from "../../finalizer-loop-observation.js";

if (!parentPort) throw new Error("Diagnostic control parent missing");
const port = parentPort;
const stop = startFinalizerLoopObservation(workerData.buffer);
port.on("message", (message) => {
	if (message === "pause") {
		// Sensitivity control only: never used by product code or claimed as QA cause.
		Atomics.wait(new Int32Array(new SharedArrayBuffer(4)), 0, 0, 900);
		port.postMessage({ category: "paused" });
	} else if (message === "exchange") {
		port.postMessage({ category: "exchange" });
	} else if (message === "stop") {
		stop();
		port.postMessage({ category: "closed" });
		port.close();
	}
});
