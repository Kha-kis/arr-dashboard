import { enrollSqliteRestoreRuntimeStorage } from "../../restore-runtime-sqlite-enrollment.js";

const pending = enrollSqliteRestoreRuntimeStorage(process.argv[2]!);
if (process.argv[3] === "interrupt") {
	// Enrollment has created coordination but yielded before anchor insertion.
	// Real process death rolls back the main transaction and releases native locks.
	process.kill(process.pid, "SIGKILL");
}
try {
	const result = await pending;
	process.send?.({ kind: "owned" });
	process.on("message", async () => {
		await result.ownership.close();
		process.send?.({ kind: "closed" });
		process.disconnect?.();
	});
} catch {
	process.send?.({ kind: "unavailable" });
	process.disconnect?.();
}
