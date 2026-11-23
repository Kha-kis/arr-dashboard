// Project a bounded log tail into fixed counters, never raw records or messages.
const { readSync } = require("node:fs");

const MAX_BYTES = 256 * 1024;
const MAX_LINES = 1000;
const shutdownMessages = new Set([
	"[Launcher] Received SIGTERM, shutting down...",
	"[Launcher] Received SIGINT, shutting down...",
]);

function summarizeLauncher(logs) {
	if (typeof logs !== "string" || Buffer.byteLength(logs) > MAX_BYTES)
		throw new Error("launcher-diagnostic-input-limit");
	const lines = logs.split("\n");
	if (lines.length > MAX_LINES) throw new Error("launcher-diagnostic-input-limit");
	const result = {
		forcedChild: 0,
		handoffRevocationFailed: 0,
		handoffRejected: 0,
		shutdown: 0,
		unreadableJson: 0,
		unrecognizedLauncher: 0,
	};
	for (const line of lines) {
		if (shutdownMessages.has(line)) {
			result.shutdown++;
			continue;
		}
		if (!line.trimStart().startsWith("{")) continue;
		let row;
		try {
			row = JSON.parse(line);
		} catch {
			result.unreadableJson++;
			continue;
		}
		if (shutdownMessages.has(row.msg)) result.shutdown++;
		if (row.category !== "launcher-shutdown-failure") continue;
		if (row.reason === "forced-child-termination") result.forcedChild++;
		else if (row.reason === "handoff-revocation-failed") result.handoffRevocationFailed++;
		else if (row.reason === "combined-handoff-rejected") result.handoffRejected++;
		else result.unrecognizedLauncher++;
	}
	return result;
}

function readBounded() {
	const chunks = [];
	const buffer = Buffer.alloc(16 * 1024);
	let total = 0;
	for (;;) {
		const size = readSync(0, buffer, 0, buffer.length);
		if (!size) return Buffer.concat(chunks).toString("utf8");
		total += size;
		if (total > MAX_BYTES) throw new Error("launcher-diagnostic-input-limit");
		chunks.push(Buffer.from(buffer.subarray(0, size)));
	}
}

if (require.main === module) {
	try {
		if (process.argv.length !== 2) throw new Error("launcher-diagnostic-arguments");
		const result = summarizeLauncher(readBounded());
		process.stdout.write(
			`forced_child=${result.forcedChild} handoff_revocation_failed=${result.handoffRevocationFailed}` +
				` handoff_rejected=${result.handoffRejected} shutdown=${result.shutdown}` +
				` unreadable_json=${result.unreadableJson} unrecognized_launcher=${result.unrecognizedLauncher}\n`,
		);
	} catch {
		process.exitCode = 1;
	}
}

module.exports = { summarizeLauncher };
