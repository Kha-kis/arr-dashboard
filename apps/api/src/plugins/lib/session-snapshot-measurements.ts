import { createHash } from "node:crypto";
import {
	getSessionBandwidthKbps,
	measureSessionBandwidth,
	normalizeSessionPlaybackDecision,
} from "@arr/shared";
import { z } from "zod";
import type { JellyfinSession } from "../../lib/jellyfin/jellyfin-client.js";
import { projectJellyfinSessionMeasurements } from "../../lib/jellyfin/jellyfin-session-measurements.js";
import type { PlexSessionItem } from "../../lib/plex/plex-client.js";
import { normalizePlexSessionUserId } from "../../lib/plex/plex-session-identity.js";
import {
	normalizeJellyfinMediaType,
	normalizePlexMediaType,
} from "./session-enrichment-helpers.js";
import { classifySessionDecisions } from "./session-snapshot-helpers.js";

export type SessionSnapshotProvider = "PLEX" | "JELLYFIN" | "EMBY";
const count = z.number().int().min(0).max(2_147_483_647);
const sourceScopeSchema = z
	.object({ connectionGeneration: count, identityGeneration: count })
	.strict();
export type SessionSnapshotSourceScope = z.infer<typeof sourceScopeSchema>;
const rate = z.number().finite().nonnegative();
const methods = z
	.object({
		directPlayCount: count,
		transcodeCount: count,
		directStreamCount: count,
		unknownDecisionCount: count,
	})
	.strict();
const unavailableNetwork = z
	.object({ status: z.literal("unavailable"), lanKbps: z.null(), wanKbps: z.null() })
	.strict();
const base = {
	version: z.literal(1),
	provider: z.enum(["PLEX", "JELLYFIN", "EMBY"]),
	// Immutable coordinates of the configured source used for this native read.
	// Historic receipts without captured generations remain identity-unverified.
	sourceScope: sourceScopeSchema.optional(),
	// Earlier native v1 rows retain usable per-track details without this marker.
	methodAxis: z.literal("video").optional(),
	// Older Plex native rows may contain manufactured or lossy coerced IDs.
	userIdentity: z.literal("provider-native").optional(),
	// Older JF/Emby rows may have substituted a device name for a missing Client.
	deviceLabelAxis: z.enum(["platform", "client"]).optional(),
	bandwidthBasis: z.enum(["provider-reported", "encoding-estimate"]),
};
const receiptSchema = z
	.discriminatedUnion("status", [
		z
			.object({
				...base,
				status: z.literal("active"),
				observedSessions: count.min(1),
				bandwidth: z
					.object({
						status: z.enum(["complete", "partial", "unavailable"]),
						observedSessions: count,
						measuredSessions: count,
						knownTotalKbps: rate.nullable(),
					})
					.strict(),
				methods,
				network: unavailableNetwork,
			})
			.strict(),
		z
			.object({
				...base,
				status: z.literal("idle"),
				observedSessions: z.literal(0),
				bandwidth: z
					.object({
						status: z.literal("complete"),
						observedSessions: z.literal(0),
						measuredSessions: z.literal(0),
						knownTotalKbps: z.literal(0),
					})
					.strict(),
				methods: z
					.object({
						directPlayCount: z.literal(0),
						transcodeCount: z.literal(0),
						directStreamCount: z.literal(0),
						unknownDecisionCount: z.literal(0),
					})
					.strict(),
				network: z
					.object({ status: z.literal("complete"), lanKbps: z.literal(0), wanKbps: z.literal(0) })
					.strict(),
			})
			.strict(),
		z
			.object({
				...base,
				status: z.literal("failed"),
				observedSessions: z.null(),
				bandwidth: z.null(),
				methods: z.null(),
				network: unavailableNetwork,
			})
			.strict(),
	])
	.superRefine((receipt, context) => {
		if (
			receipt.deviceLabelAxis !== undefined &&
			receipt.deviceLabelAxis !== (receipt.provider === "PLEX" ? "platform" : "client")
		) {
			context.addIssue({ code: "custom", message: "Provider device label axis mismatch" });
		}
		if (
			receipt.bandwidthBasis !==
			(receipt.provider === "PLEX" ? "provider-reported" : "encoding-estimate")
		) {
			context.addIssue({ code: "custom", message: "Provider rate basis mismatch" });
		}
		if (receipt.status !== "active") return;
		const bandwidth = receipt.bandwidth;
		const expectedStatus =
			bandwidth.knownTotalKbps === null
				? "unavailable"
				: bandwidth.measuredSessions === receipt.observedSessions
					? "complete"
					: "partial";
		if (
			Object.values(receipt.methods).reduce((sum, value) => sum + value, 0) !==
				receipt.observedSessions ||
			bandwidth.observedSessions !== receipt.observedSessions ||
			bandwidth.measuredSessions > receipt.observedSessions ||
			bandwidth.status !== expectedStatus ||
			(bandwidth.knownTotalKbps !== null && bandwidth.measuredSessions === 0)
		) {
			context.addIssue({ code: "custom", message: "Contradictory session measurement coverage" });
		}
	});

export type SessionSnapshotMeasurement = z.infer<typeof receiptSchema>;
export type ParsedSessionSnapshotMeasurement =
	| { status: "verified"; measurement: SessionSnapshotMeasurement }
	| { status: "legacy" }
	| { status: "invalid" };

/** Historical Plex coercion cannot establish exact native user identity. */
export function readSessionSnapshotUserId(
	row: Record<string, unknown> | null,
	receipt: SessionSnapshotMeasurement,
): string | null {
	if (receipt.provider === "PLEX" && receipt.userIdentity !== "provider-native") return null;
	return typeof row?.userId === "string" && row.userId.trim().length > 0 ? row.userId : null;
}

/** Informational captured actor coordinates, never cleanup or mutation authority. */
export function readSessionSnapshotActorKey(
	instanceId: unknown,
	row: Record<string, unknown> | null,
	receipt: SessionSnapshotMeasurement,
): string | null {
	if (
		typeof instanceId !== "string" ||
		instanceId.trim().length === 0 ||
		!["PLEX", "JELLYFIN", "EMBY"].includes(receipt.provider)
	)
		return null;
	const scope = sourceScopeSchema.safeParse(receipt.sourceScope);
	const nativeUserId = readSessionSnapshotUserId(row, receipt);
	if (!scope.success || nativeUserId === null) return null;
	return createHash("sha256")
		.update(
			JSON.stringify([
				instanceId,
				receipt.provider,
				scope.data.connectionGeneration,
				scope.data.identityGeneration,
				nativeUserId,
			]),
		)
		.digest("hex");
}

/** Missing receipts cannot retroactively certify historic numeric defaults. */
export function parseSessionSnapshotMeasurement(
	value: string | null | undefined,
): ParsedSessionSnapshotMeasurement {
	if (value === null || value === undefined) return { status: "legacy" };
	try {
		const result = receiptSchema.safeParse(JSON.parse(value));
		return result.success
			? { status: "verified", measurement: result.data }
			: { status: "invalid" };
	} catch {
		return { status: "invalid" };
	}
}

function text(value: string | undefined): string | null {
	return value?.trim() || null;
}
function decision(value: unknown): string {
	switch (normalizeSessionPlaybackDecision(value)) {
		case "direct_play":
			return "direct play";
		case "direct_stream":
			return "copy";
		case "transcode":
			return "transcode";
		default:
			return "unknown";
	}
}

function snapshot<T extends { bandwidth: number | null; videoDecision: string }>(
	provider: SessionSnapshotProvider,
	rows: T[],
	sourceScope?: SessionSnapshotSourceScope,
) {
	const bandwidth = measureSessionBandwidth(rows);
	const { totalBandwidth: _unused, ...methodCounts } = classifySessionDecisions(rows);
	const receipt = receiptSchema.parse({
		version: 1,
		provider,
		sourceScope,
		methodAxis: "video",
		userIdentity: "provider-native",
		deviceLabelAxis: provider === "PLEX" ? "platform" : "client",
		status: rows.length === 0 ? "idle" : "active",
		bandwidthBasis: provider === "PLEX" ? "provider-reported" : "encoding-estimate",
		observedSessions: rows.length,
		bandwidth,
		methods: methodCounts,
		network:
			rows.length === 0
				? { status: "complete", lanKbps: 0, wanKbps: 0 }
				: { status: "unavailable", lanKbps: null, wanKbps: null },
	});
	// Old Int columns are compatibility projections, not measurement authority.
	// Preserve exact fractional and large values in the receipt and detail rows.
	const rounded = Math.round(bandwidth.knownTotalKbps ?? 0);
	return {
		concurrentStreams: rows.length,
		totalBandwidth: rounded <= 2_147_483_647 ? rounded : 0,
		lanBandwidth: 0,
		wanBandwidth: 0,
		directPlayCount: methodCounts.directPlayCount,
		transcodeCount: methodCounts.transcodeCount,
		directStreamCount: methodCounts.directStreamCount,
		sessionsJson: JSON.stringify(rows),
		measurementJson: JSON.stringify(receipt),
	};
}

/** Informational native coordinates never establish cleanup or deletion authority. */
export function buildPlexSessionSnapshot(
	sessions: PlexSessionItem[],
	sourceScope?: SessionSnapshotSourceScope,
) {
	const rows = sessions.map((session) => ({
		provider: "PLEX" as const,
		sessionId: session.sessionKey,
		itemId: session.ratingKey,
		userId: normalizePlexSessionUserId(session.user.id),
		positionMs: session.viewOffset,
		durationMs: session.duration,
		user: session.user.title,
		title: session.grandparentTitle
			? `${session.grandparentTitle} - ${session.title}`
			: session.title,
		grandparentTitle: session.grandparentTitle,
		mediaType: normalizePlexMediaType(session.type),
		videoDecision: decision(session.videoDecision),
		audioDecision: decision(session.audioDecision),
		bandwidth: getSessionBandwidthKbps(session.bandwidth),
		state: session.state,
		videoCodec: text(session.videoCodec),
		audioCodec: text(session.audioCodec),
		videoResolution: text(session.videoResolution),
		platform: text(session.player.platform),
		player: text(session.player.title),
	}));
	return snapshot("PLEX", rows, sourceScope);
}

export function buildJellyfinSessionSnapshot(
	sessions: JellyfinSession[],
	provider: "JELLYFIN" | "EMBY",
	sourceScope?: SessionSnapshotSourceScope,
) {
	const rows = sessions.map((session) => {
		const measurement = projectJellyfinSessionMeasurements(session);
		return {
			provider,
			sessionId: session.id,
			itemId: session.nowPlayingItem?.id ?? null,
			userId: session.userId ?? null,
			positionMs: session.positionMs,
			durationMs: session.durationMs,
			user: session.userName ?? "Unknown",
			title: session.nowPlayingItem?.name ?? "Unknown",
			grandparentTitle: session.nowPlayingItem?.seriesName,
			mediaType: normalizeJellyfinMediaType(session.nowPlayingItem?.type),
			videoDecision: measurement.videoDecision,
			audioDecision: measurement.audioDecision,
			playbackDecision: decision(session.playMethod),
			bandwidth: getSessionBandwidthKbps(measurement.bandwidth),
			state: session.isPaused ? "paused" : "playing",
			videoCodec: text(measurement.videoCodec),
			audioCodec: text(measurement.audioCodec),
			videoResolution: text(measurement.videoResolution),
			platform: text(session.client),
			player: text(session.deviceName),
		};
	});
	return snapshot(provider, rows, sourceScope);
}

export function buildFailedSessionSnapshot(
	provider: SessionSnapshotProvider,
	sourceScope?: SessionSnapshotSourceScope,
) {
	const receipt = receiptSchema.parse({
		version: 1,
		provider,
		sourceScope,
		methodAxis: "video",
		status: "failed",
		deviceLabelAxis: provider === "PLEX" ? "platform" : "client",
		bandwidthBasis: provider === "PLEX" ? "provider-reported" : "encoding-estimate",
		observedSessions: null,
		bandwidth: null,
		methods: null,
		network: { status: "unavailable", lanKbps: null, wanKbps: null },
	});
	return {
		concurrentStreams: 0,
		totalBandwidth: 0,
		lanBandwidth: 0,
		wanBandwidth: 0,
		directPlayCount: 0,
		transcodeCount: 0,
		directStreamCount: 0,
		sessionsJson: "[]",
		measurementJson: JSON.stringify(receipt),
	};
}
