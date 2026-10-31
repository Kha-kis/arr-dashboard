import { describe, expect, it } from "vitest";
import { deduplicateWatchEvents } from "../lib/watch-history-helpers.js";

const session = {
	user: "Synthetic viewer",
	title: "Synthetic title",
	platform: "Synthetic device",
	videoDecision: "direct play",
};
const receipt = {
	version: 1,
	provider: "JELLYFIN",
	bandwidthBasis: "encoding-estimate",
	status: "active",
	observedSessions: 1,
	bandwidth: {
		status: "unavailable",
		observedSessions: 1,
		measuredSessions: 0,
		knownTotalKbps: null,
	},
	methods: { directPlayCount: 1, directStreamCount: 0, transcodeCount: 0, unknownDecisionCount: 0 },
	network: { status: "unavailable", lanKbps: null, wanKbps: null },
};

function event(measurement?: Record<string, unknown>, rows: unknown[] = [session]) {
	return deduplicateWatchEvents(
		[
			{
				capturedAt: new Date("2026-10-05T12:00:00Z"),
				sessionsJson: JSON.stringify(rows),
				...(measurement ? { measurementJson: JSON.stringify(measurement) } : {}),
			},
		],
		50,
	).events[0];
}

describe("History native field provenance", () => {
	it("retains legacy events without certifying manufactured method or device labels", () => {
		expect(event()).toMatchObject({
			user: "Synthetic viewer",
			title: "Synthetic title",
			timestamp: "2026-10-05T12:00:00.000Z",
			platform: null,
			videoDecision: null,
		});
	});
	it("retains older native video evidence while rejecting an unverified Jellyfin device fallback", () => {
		expect(event(receipt)).toMatchObject({
			title: "Synthetic title",
			platform: null,
			videoDecision: "direct play",
		});
	});
	it.each(["JELLYFIN", "EMBY"])(
		"uses captured %s client labels when the client axis is certified",
		(provider) => {
			expect(
				event({ ...receipt, provider, methodAxis: "video", deviceLabelAxis: "client" }),
			).toMatchObject({ platform: "Synthetic device", videoDecision: "direct play" });
		},
	);
	it("uses native Plex platform evidence independently of source actor availability", () => {
		expect(
			event({ ...receipt, provider: "PLEX", bandwidthBasis: "provider-reported" }),
		).toMatchObject({ platform: "Synthetic device", videoDecision: "direct play" });
	});
	it("does not certify video fields when detail contradicts a video-axis receipt", () => {
		expect(
			event({
				...receipt,
				methodAxis: "video",
				deviceLabelAxis: "client",
				methods: {
					directPlayCount: 0,
					directStreamCount: 0,
					transcodeCount: 1,
					unknownDecisionCount: 0,
				},
			}),
		).toMatchObject({ platform: "Synthetic device", videoDecision: null });
	});
	it("retains a valid title but leaves malformed receipt evidence unknown", () => {
		expect(event({ ...receipt, observedSessions: 2 })).toMatchObject({
			title: "Synthetic title",
			platform: null,
			videoDecision: null,
		});
	});
	it("does not publish metadata from a failed receipt with contradictory retained details", () => {
		expect(
			event({
				...receipt,
				status: "failed",
				observedSessions: null,
				bandwidth: null,
				methods: null,
			}),
		).toMatchObject({ platform: null, videoDecision: null });
	});
});
