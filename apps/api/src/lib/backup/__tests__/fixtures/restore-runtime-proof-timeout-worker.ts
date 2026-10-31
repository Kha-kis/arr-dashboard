import { parentPort, workerData } from "node:worker_threads";
import {
	getRestoreRuntimeClientContext,
	openRestoreRuntimeWorker,
	type RestoreRuntime,
} from "../../restore-runtime-admission.js";
import { createRuntimePrismaClient } from "../../restore-runtime-client.js";

// Real follower and proof timer; no provider, Prisma or private data involved.
if (!parentPort) throw new Error("Fixture parent missing");
const port = parentPort;
const command = () => new Promise<void>((resolve) => port.once("message", () => resolve()));
const proofBoundary = async () => {
	const resume = command();
	port.postMessage({ category: "proof-imminent" });
	await resume;
};
let runtime: Readonly<RestoreRuntime> | undefined;
try {
	if (workerData.initialProof) await proofBoundary();
	try {
		runtime = await openRestoreRuntimeWorker(workerData.binding, workerData.databaseUrl);
	} catch {
		if (!workerData.initialProof) throw new Error("Unexpected fixture admission failure");
	}
	let accepted = false;
	let reused = false;
	if (runtime) {
		const begin = command();
		port.postMessage({ category: "ready" });
		await begin;
		try {
			if (workerData.ownerOnly) {
				const client = createRuntimePrismaClient(runtime);
				accepted =
					(await runtime.runOperation(() =>
						client.prisma.$transaction(
							async (tx) => {
								await tx.$executeRawUnsafe("INSERT INTO TimeoutProbe(value) VALUES (1)");
								await proofBoundary();
								await getRestoreRuntimeClientContext(runtime!).assertOwned();
								return 42;
							},
							{ timeout: 15_000 },
						),
					)) === 42;
			} else {
				await proofBoundary();
				accepted = (await runtime.runOperation(() => 42)) === 42;
			}
		} catch {
			// No fallback: an expired proof must deny/roll back this operation.
		}
		try {
			reused = (await runtime.runOperation(() => 24)) === 24;
		} catch {
			// A timed-out follower stays permanently fenced, even after late replies.
		}
		if (!accepted) {
			// Delayed traffic from this retired bridge must never affect a new
			// worker or grant work to this already-fenced runtime.
			workerData.binding.port.postMessage({ kind: "proof", id: 2147483647 });
		}
	}
	const close = command();
	port.postMessage({ category: "reuse", accepted: reused });
	port.postMessage({ category: "operation", accepted });
	await close;
} finally {
	await runtime?.close();
	port.postMessage({ category: "closed" });
	port.close();
}
