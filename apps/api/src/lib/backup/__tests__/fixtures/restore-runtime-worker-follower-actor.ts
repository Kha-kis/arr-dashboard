import { parentPort, workerData } from "node:worker_threads";
import {
	openRestoreRuntimeWorker,
	getRestoreRuntimeClientContext,
} from "../../restore-runtime-admission.js";
import { createRuntimePrismaClient } from "../../restore-runtime-client.js";

// Native admission actor only; no provider publication is simulated here.
if (!parentPort) throw new Error("Fixture parent missing");
const port = parentPort;
try {
	const runtime = await openRestoreRuntimeWorker(workerData.binding, workerData.databaseUrl);
	const client = createRuntimePrismaClient(runtime);
	const run = <T>(operation: () => Promise<T>) =>
		workerData.binding.record.phase === "starting"
			? runtime.runStarting(operation)
			: runtime.runOperation(operation);
	let noTicket = false,
		noActivation = false,
		noBinding = false;
	try {
		await client.prisma.user.count();
	} catch {
		noTicket = true;
	}
	try {
		await runtime.activate();
	} catch {
		noActivation = true;
	}
	try {
		await runtime.bindDestination("fixture-impostor");
	} catch {
		noBinding = true;
	}
	await run(() => client.prisma.user.create({ data: { username: "fixture-follower" } }));
	let serial = Promise.resolve();
	let resume: (() => void) | undefined;
	port.on("message", (command) => {
		if (command === "resume") {
			resume?.();
			return;
		}
		serial = serial
			.then(async () => {
				if (command === "release") {
					await runtime.close();
					port.close();
					return;
				}
				if (command === "lose") getRestoreRuntimeClientContext(runtime).unavailable();
				let written = false;
				try {
					await run(async () => {
						if (command === "borrowed") {
							await client.prisma.$transaction(async (tx) => {
								await tx.user.create({ data: { username: "fixture-prospective" } });
								const held = new Promise<void>((resolve) => {
									resume = resolve;
								});
								port.postMessage({ held: true });
								await held;
							});
						} else {
							if (command === "busy") {
								port.postMessage({ held: true });
								const words = new Int32Array(workerData.binding.fence);
								const end = performance.now() + 5000;
								while (Atomics.load(words, 0) === 0 && performance.now() < end) {
									/* Real busy isolate cannot dispatch IPC. */
								}
							}
							await client.prisma.user.create({ data: { username: "fixture-after-command" } });
						}
					});
					written = true;
				} catch {
					/* Return only the generic SQL disposition. */
				}
				port.postMessage({ written });
			})
			.catch(() => {
				port.postMessage({ failed: true });
			});
	});
	port.postMessage({ ready: true, noTicket, noActivation, noBinding });
} catch {
	port.postMessage({ failed: true });
	port.close();
}
