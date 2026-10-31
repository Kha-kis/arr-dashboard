import { acquirePostgresRestoreRuntimeOwnership } from "../../restore-runtime-postgres.js";

let owner: Awaited<ReturnType<typeof acquirePostgresRestoreRuntimeOwnership>> | undefined;
let pending = Promise.resolve();
process.on("message", (message: { id: number; command: string }) => {
	pending = pending.then(async () => {
		try {
			if (message.command === "acquire") {
				owner = await acquirePostgresRestoreRuntimeOwnership(process.env.TEST_DATABASE_URL ?? "");
				process.send?.({ id: message.id, category: "acquired", pid: owner.ownerBackendPid });
			} else if (message.command === "close") {
				await owner?.close();
				process.send?.({ id: message.id, category: "closed" });
			} else {
				process.send?.({ id: message.id, category: "invalid-command" });
			}
		} catch {
			process.send?.({ id: message.id, category: "unavailable" });
		}
	});
});
process.on("disconnect", () => {
	void pending.finally(async () => {
		await owner?.close();
		process.exit(0);
	});
});
process.send?.({ category: "ready" });
