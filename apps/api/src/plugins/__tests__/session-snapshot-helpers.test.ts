/**
 * Session Snapshot Helper Tests
 *
 * Tests for the pure classifySessionDecisions and computeLanWanAttribution helpers
 * extracted from session-snapshot-scheduler.ts.
 *
 * Run with: npx vitest run session-snapshot-helpers.test.ts
 */

import { describe, expect, it } from "vitest";
import {
	classifySessionDecisions,
	computeLanWanAttribution,
	type SessionInput,
} from "../lib/session-snapshot-helpers.js";

// ---------------------------------------------------------------------------
// classifySessionDecisions
// ---------------------------------------------------------------------------

describe("classifySessionDecisions", () => {
	it("classifies mixed session decisions correctly", () => {
		const sessions: SessionInput[] = [
			{ bandwidth: 5000, videoDecision: "transcode" },
			{ bandwidth: 8000, videoDecision: "direct play" },
			{ bandwidth: 3000, videoDecision: "copy" },
			{ bandwidth: 2000, videoDecision: "directstream" },
		];

		const result = classifySessionDecisions(sessions);
		expect(result.totalBandwidth).toBe(18000);
		expect(result.transcodeCount).toBe(1);
		expect(result.directPlayCount).toBe(1);
		expect(result.directStreamCount).toBe(2); // "copy" + "directstream"
	});

	it('counts "copy" and "direct stream" as directStream', () => {
		const sessions: SessionInput[] = [
			{ bandwidth: 1000, videoDecision: "copy" },
			{ bandwidth: 2000, videoDecision: "direct stream" },
			{ bandwidth: 3000, videoDecision: "directstream" },
		];

		const result = classifySessionDecisions(sessions);
		expect(result.directStreamCount).toBe(3);
		expect(result.directPlayCount).toBe(0);
		expect(result.transcodeCount).toBe(0);
	});

	it("defaults missing videoDecision to direct play", () => {
		const sessions: SessionInput[] = [
			{ bandwidth: 5000, videoDecision: null },
			{ bandwidth: 3000, videoDecision: undefined },
			{ bandwidth: 2000 },
		];

		const result = classifySessionDecisions(sessions);
		expect(result.directPlayCount).toBe(3);
		expect(result.transcodeCount).toBe(0);
		expect(result.directStreamCount).toBe(0);
		expect(result.totalBandwidth).toBe(10000);
	});

	it("handles null/undefined bandwidth as 0", () => {
		const sessions: SessionInput[] = [
			{ bandwidth: null, videoDecision: "transcode" },
			{ videoDecision: "direct play" },
		];

		const result = classifySessionDecisions(sessions);
		expect(result.totalBandwidth).toBe(0);
		expect(result.transcodeCount).toBe(1);
		expect(result.directPlayCount).toBe(1);
	});
});

// ---------------------------------------------------------------------------
// computeLanWanAttribution
// ---------------------------------------------------------------------------

describe("computeLanWanAttribution", () => {
	it("attributes LAN/WAN for the first instance when Tautulli data is complete", () => {
		const result = computeLanWanAttribution(true, false, 5000, 3000);
		expect(result.lanBandwidth).toBe(5000);
		expect(result.wanBandwidth).toBe(3000);
		expect(result.attributed).toBe(true);
	});

	it("zeroes LAN/WAN for the second instance (already attributed)", () => {
		const result = computeLanWanAttribution(true, true, 5000, 3000);
		expect(result.lanBandwidth).toBe(0);
		expect(result.wanBandwidth).toBe(0);
		// attributed=false because THIS call did not perform attribution (it was already done)
		expect(result.attributed).toBe(false);
	});

	it("zeroes LAN/WAN when Tautulli data is incomplete", () => {
		const result = computeLanWanAttribution(false, false, 5000, 3000);
		expect(result.lanBandwidth).toBe(0);
		expect(result.wanBandwidth).toBe(0);
		expect(result.attributed).toBe(false);
	});
});
