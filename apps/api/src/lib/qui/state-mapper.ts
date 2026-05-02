import type { QuiTorrentState } from "@arr/shared";

/**
 * High-level torrent classification used for UI status pills and
 * automation-conflict checks. Multiple qBit states collapse into the
 * same bucket — e.g. seeding/forced-seeding both render as "seeding".
 */
export type QuiTorrentStateClass =
	| "downloading"
	| "seeding"
	| "paused"
	| "queued"
	| "checking"
	| "stalled"
	| "error"
	| "moving"
	| "unknown";

const STATE_CLASS: Record<QuiTorrentState, QuiTorrentStateClass> = {
	downloading: "downloading",
	uploading: "seeding",
	stalledUP: "stalled",
	stalledDL: "stalled",
	pausedUP: "paused",
	pausedDL: "paused",
	queuedUP: "queued",
	queuedDL: "queued",
	checkingUP: "checking",
	checkingDL: "checking",
	metaDL: "downloading",
	moving: "moving",
	forcedUP: "seeding",
	forcedDL: "downloading",
	error: "error",
	missingFiles: "error",
	unknown: "unknown",
};

/** Map a raw qBit state string to the high-level UI classification. */
export function classifyTorrentState(state: QuiTorrentState): QuiTorrentStateClass {
	return STATE_CLASS[state] ?? "unknown";
}

/**
 * True when the torrent is actively contributing upload bandwidth.
 * Used by the Library Cleanup "still seeding" gate (Phase 2.2) — we
 * never want to delete files for a torrent in this state without
 * explicit operator override.
 */
export function isActivelySeeding(state: QuiTorrentState): boolean {
	const cls = classifyTorrentState(state);
	return cls === "seeding" || (cls === "stalled" && state === "stalledUP");
}

/** True when the torrent is in a terminal error state. */
export function isErrorState(state: QuiTorrentState): boolean {
	return classifyTorrentState(state) === "error";
}
