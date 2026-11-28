// Read only the bounded Docker log tail supplied by the smoke test.
const { readFileSync } = require("node:fs");

const phases = new Set(["initialization", "fastify", "runtime", "complete", "failed"]);
const failingPhases = new Set(["initialization", "fastify", "runtime"]);
const runtimeStages = new Set([
	"activation",
	"controls",
	"replacement",
	"operations",
	"clients",
	"backend",
]);
const runtimePhases = new Set(["idle", ...runtimeStages, "closed", "failed"]);
const operationSources = new Set([
	"bootstrap",
	"operation",
	"independent",
	"retained",
	"session-validation",
	"connection-warmup",
	"scheduler",
	"cleanup-independent",
]);
const operationStages = new Set([
	"admission",
	"callback",
	"participation-release",
	"release-failed",
]);
const jobKinds = new Set([
	"backup",
	"session-cleanup",
	"session-snapshot",
	"library-sync",
	"hunting",
	"queue-cleaner",
	"arr-import-observation",
	"library-cleanup",
	"insights-digest",
	"trash-backup-cleanup",
	"trash-update",
	"trash-sync",
	"plex-cache",
	"plex-episode-cache",
	"jellyfin-cache",
	"jellyfin-episode-cache",
	"jellyfin-positive-watch",
	"native-inventory",
	"native-inventory-retention",
	"tautulli-cache",
	"seerr-health",
	"label-sync",
	"auto-tag",
	"tmdb-list-cache",
	"trakt-list-cache",
	"qui-torrent-state-sync",
	"infohash-backfill",
	"history-collection",
	"other",
]);

const isCount = (value) => Number.isSafeInteger(value) && value >= 0;
const counts = (record, keys) =>
	Object.fromEntries(keys.filter((key) => isCount(record[key])).map((key) => [key, record[key]]));

function summarizeRuntime(record) {
	if (!runtimePhases.has(record?.phase)) return undefined;
	return {
		phase: record.phase,
		failedPhase: runtimeStages.has(record.failedPhase) ? record.failedPhase : undefined,
		admissionClosed:
			typeof record.admissionClosed === "boolean" ? record.admissionClosed : undefined,
		...counts(record, [
			"activeOperations",
			"retainedOperations",
			"registeredClients",
			"pendingClientCloses",
		]),
		activeOperationGroups: Array.isArray(record.activeOperationGroups)
			? record.activeOperationGroups
					.slice(0, 32)
					.filter(
						(group) =>
							operationSources.has(group?.source) &&
							operationStages.has(group.stage) &&
							isCount(group.count) &&
							isCount(group.oldestMs),
					)
					.map(({ source, stage, count, oldestMs }) => ({ source, stage, count, oldestMs }))
			: undefined,
	};
}

function summarizeProgress(logs) {
	const latest = new Map();
	let observations = 0;
	for (const line of logs.split("\n")) {
		if (!line.startsWith("{") || line.length > 8192) continue;
		let row;
		try {
			row = JSON.parse(line);
		} catch {
			continue;
		}
		if (
			row?.category !== "shutdown-progress" ||
			!phases.has(row.phase) ||
			!Number.isFinite(row.elapsedMs) ||
			!isCount(Math.round(row.elapsedMs)) ||
			row.elapsedMs < 0
		)
			continue;
		observations++;
		latest.set(row.phase, {
			phase: row.phase,
			elapsedMs: Math.round(row.elapsedMs),
			failedPhase: failingPhases.has(row.failedPhase) ? row.failedPhase : undefined,
			admissionClosed: typeof row.admissionClosed === "boolean" ? row.admissionClosed : undefined,
			...counts(row, ["pendingHandlers", "runningSchedulers"]),
			runningSchedulerKinds: Array.isArray(row.runningSchedulerKinds)
				? row.runningSchedulerKinds
						.slice(0, 32)
						.filter((job) => jobKinds.has(job?.kind) && isCount(job.count))
						.map(({ kind, count }) => ({ kind, count }))
				: undefined,
			runtime: summarizeRuntime(row.runtime),
		});
	}
	return { observations, latestByPhase: [...latest.values()] };
}

process.stdout.write(`${JSON.stringify(summarizeProgress(readFileSync(0, "utf8")))}\n`);
