/**
 * qui torrent-state notifications (Phase 2.5).
 *
 * The periodic qui torrent-state sync (`runQuiTorrentStateSync`) already
 * walks every *arr-correlated torrent and writes its normalized state into
 * LibraryCache. This module turns that sweep into a notification source:
 * when a torrent *transitions into* a problem state, emit a notification
 * through the existing dispatcher so the operator's configured channels
 * (Discord, ntfy, …) get told.
 *
 * Why transitions, not states: firing on "is in error state" would re-
 * notify every sync cycle (~30 min) for as long as the torrent stays
 * broken. Firing on the *crossing* healthy→error notifies exactly once.
 * The dispatcher's dedup gate is a second layer of defense.
 *
 * Scope: only torrents with a LibraryCache row (i.e. correlated to *arr
 * content) trigger notifications. A random torrent erroring that isn't
 * part of the operator's media library is noise.
 *
 * v1 covers the two problem states detectable from the sync's existing
 * data (`torrentState`): `error` and `stalled_dl`. Tracker-health events
 * would need per-torrent tracker fetches and are deferred.
 */

import type { NotificationEventType } from "@arr/shared";

/**
 * Above this many transitions of the same kind in a single sync run, emit
 * ONE aggregate notification instead of N individual ones. Protects
 * against notification storms when a tracker outage errors many torrents
 * at once.
 */
export const AGGREGATE_THRESHOLD = 5;

/** A torrent crossing into a problem state during one sync run. */
export interface ProblemTransition {
	kind: "errored" | "stalled";
	infoHash: string;
	/** *arr library title for the correlated item (LibraryCache.title). */
	title: string;
	instanceLabel: string;
	oldState: string | null;
	newState: string;
}

/** Minimal notification payload shape — matches NotificationService.notify. */
export interface QuiNotificationPayload {
	eventType: NotificationEventType;
	title: string;
	body: string;
	url: string;
	metadata: Record<string, unknown>;
}

/**
 * Classify a (oldState → newState) pair. Returns the problem-transition
 * kind, or null when this isn't a fresh crossing into a problem state.
 *
 * A null/undefined `oldState` (torrent newly correlated, or state never
 * synced before) is treated as "not previously a problem" — so an
 * unseen→error pair IS a transition worth notifying.
 */
export function classifyTransition(
	oldState: string | null | undefined,
	newState: string,
): ProblemTransition["kind"] | null {
	if (newState === "error" && oldState !== "error") return "errored";
	if (newState === "stalled_dl" && oldState !== "stalled_dl") return "stalled";
	return null;
}

const KIND_TO_EVENT: Record<ProblemTransition["kind"], NotificationEventType> = {
	errored: "QUI_TORRENT_ERRORED",
	stalled: "QUI_DOWNLOAD_STALLED",
};

const KIND_TO_VERB: Record<ProblemTransition["kind"], string> = {
	errored: "errored",
	stalled: "stalled",
};

/**
 * Build the notification payloads for a set of transitions detected in one
 * sync run. Groups by kind; a kind with more than `AGGREGATE_THRESHOLD`
 * transitions collapses into a single summary payload.
 *
 * Pure function — exposed for unit testing the individual-vs-aggregate
 * branching independent of the dispatcher.
 */
export function buildNotificationPayloads(
	transitions: ProblemTransition[],
): QuiNotificationPayload[] {
	const byKind = new Map<ProblemTransition["kind"], ProblemTransition[]>();
	for (const t of transitions) {
		const list = byKind.get(t.kind);
		if (list) list.push(t);
		else byKind.set(t.kind, [t]);
	}

	const payloads: QuiNotificationPayload[] = [];
	for (const [kind, list] of byKind) {
		const eventType = KIND_TO_EVENT[kind];
		const verb = KIND_TO_VERB[kind];

		if (list.length > AGGREGATE_THRESHOLD) {
			// Storm — one summary instead of a flood.
			const sample = list.slice(0, 5).map((t) => t.title);
			payloads.push({
				eventType,
				title: `${list.length} torrents ${verb}`,
				body: `${list.length} *arr-tracked torrents ${verb} in qui. Newest: ${sample.join(", ")}${
					list.length > sample.length ? ", …" : ""
				}`,
				url: "/qui",
				metadata: {
					aggregate: true,
					kind,
					count: list.length,
					sampleTitles: sample,
				},
			});
		} else {
			for (const t of list) {
				payloads.push({
					eventType,
					title: `Torrent ${verb}: ${t.title}`,
					body: `"${t.title}" ${verb} in qui (${t.instanceLabel}).`,
					url: "/qui",
					metadata: {
						aggregate: false,
						kind,
						infoHash: t.infoHash,
						torrentTitle: t.title,
						instanceLabel: t.instanceLabel,
						oldState: t.oldState,
						newState: t.newState,
					},
				});
			}
		}
	}
	return payloads;
}
