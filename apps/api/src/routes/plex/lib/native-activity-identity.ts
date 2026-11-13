import {
	parseSessionSnapshotMeasurement,
	readSessionSnapshotActorKey,
	type SessionSnapshotMeasurement,
} from "../../../plugins/lib/session-snapshot-measurements.js";

export interface ActivitySnapshotIdentity {
	instanceId?: string;
	measurementJson?: string | null;
	concurrentStreams?: number;
}

/** The receipt certifies its complete detail row count, not labels or guessed IDs. */
export function readActivityReceipt(
	snapshot: ActivitySnapshotIdentity,
	rowCount: number,
): Extract<SessionSnapshotMeasurement, { status: "active" }> | null {
	const parsed = parseSessionSnapshotMeasurement(snapshot.measurementJson);
	return parsed.status === "verified" &&
		parsed.measurement.status === "active" &&
		parsed.measurement.observedSessions === rowCount &&
		(snapshot.concurrentStreams === undefined || snapshot.concurrentStreams === rowCount)
		? parsed.measurement
		: null;
}

export function readActivityIdentity(
	snapshot: ActivitySnapshotIdentity,
	row: Record<string, unknown>,
	receipt: SessionSnapshotMeasurement | null,
): { actor: string | null; playback: string | null } {
	const actor =
		receipt && (row.provider === undefined || row.provider === receipt.provider)
			? readSessionSnapshotActorKey(snapshot.instanceId, row, receipt)
			: null;
	const item = typeof row.itemId === "string" && row.itemId.trim() ? row.itemId : null;
	const session = typeof row.sessionId === "string" && row.sessionId.trim() ? row.sessionId : null;
	return {
		actor,
		playback: actor && item && session ? JSON.stringify([actor, item, session]) : null,
	};
}
