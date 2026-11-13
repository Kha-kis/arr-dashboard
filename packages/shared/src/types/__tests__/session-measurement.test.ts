import { describe, expect, it } from "vitest";
import {
	getSessionBandwidthKbps,
	measureSessionBandwidth,
	normalizeSessionPlaybackDecision,
} from "../session";

describe("normalizeSessionPlaybackDecision", () => {
	it.each([
		["direct play", "direct_play"],
		["DirectPlay", "direct_play"],
		["  DIRECT PLAY  ", "direct_play"],
		["copy", "direct_stream"],
		["direct stream", "direct_stream"],
		["DirectStream", "direct_stream"],
		["  COPY  ", "direct_stream"],
		["transcode", "transcode"],
		["  Transcode  ", "transcode"],
	])("normalizes explicit method %j to %s", (input, expected) => {
		expect(normalizeSessionPlaybackDecision(input)).toBe(expected);
	});

	it.each(
		[
			undefined,
			null,
			"",
			"  ",
			"unknown",
			"buffering",
			"not direct play",
			"transcode failed",
			"copy-unverified",
			0,
			false,
			{},
			["DirectPlay"],
		].map((input) => ({ input })),
	)("does not invent a known method for $input", ({ input }) => {
		expect(normalizeSessionPlaybackDecision(input)).toBe("unknown");
	});
});

describe("stream-rate measurement coverage", () => {
	it.each([
		{ value: 0, expected: 0 },
		{ value: 12.5, expected: 12.5 },
		{ value: undefined, expected: null },
		{ value: null, expected: null },
		{ value: "0", expected: null },
		{ value: false, expected: null },
		{ value: -1, expected: null },
		{ value: Number.NaN, expected: null },
		{ value: Number.POSITIVE_INFINITY, expected: null },
	])("validates $value without coercion", ({ value, expected }) => {
		expect(getSessionBandwidthKbps(value)).toBe(expected);
	});
	it.each([
		{
			rows: [],
			expected: { status: "complete", observedSessions: 0, measuredSessions: 0, knownTotalKbps: 0 },
		},
		{
			rows: [{ bandwidth: 0 }],
			expected: { status: "complete", observedSessions: 1, measuredSessions: 1, knownTotalKbps: 0 },
		},
		{
			rows: [{ bandwidth: 12.5 }, { bandwidth: 0 }],
			expected: {
				status: "complete",
				observedSessions: 2,
				measuredSessions: 2,
				knownTotalKbps: 12.5,
			},
		},
		{
			rows: [{}],
			expected: {
				status: "unavailable",
				observedSessions: 1,
				measuredSessions: 0,
				knownTotalKbps: null,
			},
		},
		{
			rows: [{ bandwidth: 0 }, {}],
			expected: { status: "partial", observedSessions: 2, measuredSessions: 1, knownTotalKbps: 0 },
		},
		{
			rows: [{ bandwidth: -1 }, { bandwidth: 25 }],
			expected: { status: "partial", observedSessions: 2, measuredSessions: 1, knownTotalKbps: 25 },
		},
		{
			rows: [{ bandwidth: Number.MAX_VALUE }, { bandwidth: Number.MAX_VALUE }],
			expected: {
				status: "unavailable",
				observedSessions: 2,
				measuredSessions: 2,
				knownTotalKbps: null,
			},
		},
	])("describes measured evidence for $rows", ({ rows, expected }) => {
		expect(measureSessionBandwidth(rows)).toEqual(expected);
	});
});
