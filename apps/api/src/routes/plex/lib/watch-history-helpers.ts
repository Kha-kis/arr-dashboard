/**
 * Watch History Helpers
 *
 * Pure functions for deduplicating consecutive session entries into
 * discrete watch events from SessionSnapshot data.
 */

import { createHash } from "node:crypto";
import type { WatchHistoryEvent } from "@arr/shared";
import {
	type ActivitySnapshotIdentity,
	readActivityIdentity,
	readActivityReceipt,
} from "./native-activity-identity.js";
import { readVideoMethods } from "./transcode-analytics-helpers.js";

/** Raw session entry parsed from sessionsJson, with a timestamp from the snapshot */
export interface RawWatchEvent {
	user: string;
	title: string;
	timestamp: Date;
	platform: string | null;
	videoDecision: string | null;
}

/** Snapshot row for watch history extraction */
export interface SnapshotForHistory extends ActivitySnapshotIdentity {
	id?: string;
	capturedAt: Date;
	sessionsJson: string;
	measurementJson?: string | null;
}

/**
 * Extract and deduplicate watch events from session snapshots.
 *
 * Consecutive 5-minute ticks for the same user+title are collapsed into
 * a single event (the most recent timestamp), since they represent one
 * continuous viewing session rather than separate plays.
 */
export interface WatchHistoryResult {
	events: WatchHistoryEvent[];
	parseFailures: number;
	totalSnapshots: number;
	failedPreviews: string[];
}

export interface WatchHistoryAccumulator {
	addBatch(snapshots: readonly SnapshotForHistory[]): void;
	getResult(): WatchHistoryResult;
}

export function createWatchHistoryAccumulator(limit: number): WatchHistoryAccumulator {
	let parseFailures = 0;
	let totalSnapshots = 0;
	const failedPreviews: string[] = [];
	// Deduplicate: collapse consecutive entries for same user+title
	// "Consecutive" = within 10 minutes; each skipped tick advances the chain.
	const DEDUP_WINDOW_MS = 10 * 60 * 1000;
	const deduped: WatchHistoryEvent[] = [];
	const lastSeen = new Map<string, number>(); // key → last timestamp
	let snapshotSequence = 0;

	function addBatch(snapshots: readonly SnapshotForHistory[]): void {
		totalSnapshots += snapshots.length;
		for (const snap of snapshots) {
			const snapshotOrdinal = snapshotSequence++;
			let sessions: unknown;
			try {
				sessions = JSON.parse(snap.sessionsJson);
			} catch {
				parseFailures++;
				continue;
			}

			// Keep checking rows for parse diagnostics after enough output events
			// have been emitted, without retaining or aggregating unused raw events.
			if (!Array.isArray(sessions)) {
				parseFailures++;
				continue;
			}
			if (deduped.length > 0 && deduped.length >= limit) continue;

			const receipt = readActivityReceipt(snap, sessions.length);
			const methods = receipt ? readVideoMethods(snap.sessionsJson, receipt).decisions : null;
			const platformVerified =
				receipt !== null &&
				sessions.length === receipt.observedSessions &&
				(receipt.provider === "PLEX" || receipt.deviceLabelAxis === "client");

			for (const [index, value] of sessions.entries()) {
				if (value === null || typeof value !== "object" || Array.isArray(value)) continue;
				const session = value as Record<string, unknown>;
				const user =
					typeof session.user === "string" && session.user.trim() ? session.user : "Unknown";
				const title =
					typeof session.title === "string" && session.title.trim() ? session.title : "Unknown";
				const key = readActivityIdentity(snap, session, receipt).playback;
				const prevTime = key ? lastSeen.get(key) : undefined;
				const eventTime = snap.capturedAt.getTime();

				if (prevTime !== undefined && prevTime - eventTime <= DEDUP_WINDOW_MS) {
					if (key) lastSeen.set(key, eventTime);
					continue;
				}

				if (key) lastSeen.set(key, eventTime);
				deduped.push({
					key: createHash("sha256")
						.update(
							JSON.stringify(
								key
									? [key, snap.capturedAt.toISOString()]
									: [
											snap.instanceId ?? null,
											snap.id ?? snapshotOrdinal,
											snap.capturedAt.toISOString(),
											index,
										],
							),
						)
						.digest("hex"),
					user,
					title,
					timestamp: snap.capturedAt.toISOString(),
					platform:
						platformVerified && typeof session.platform === "string"
							? session.platform.trim() || null
							: null,
					videoDecision:
						methods?.[index] === "direct_play"
							? "direct play"
							: methods?.[index] === "direct_stream"
								? "copy"
								: methods?.[index] === "transcode"
									? "transcode"
									: null,
				});

				if (deduped.length >= limit) break;
			}
		}
	}

	function getResult(): WatchHistoryResult {
		return { events: deduped, parseFailures, totalSnapshots, failedPreviews };
	}

	return { addBatch, getResult };
}

export function deduplicateWatchEvents(
	snapshots: SnapshotForHistory[],
	limit: number,
): WatchHistoryResult {
	const accumulator = createWatchHistoryAccumulator(limit);
	accumulator.addBatch(
		[...snapshots].sort((left, right) => right.capturedAt.getTime() - left.capturedAt.getTime()),
	);
	return accumulator.getResult();
}
