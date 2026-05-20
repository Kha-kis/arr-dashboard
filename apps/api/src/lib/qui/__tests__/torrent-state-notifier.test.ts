import { describe, expect, it } from "vitest";
import {
	AGGREGATE_THRESHOLD,
	buildNotificationPayloads,
	classifyTransition,
	type ProblemTransition,
} from "../torrent-state-notifier.js";

describe("classifyTransition", () => {
	it("flags a crossing into error", () => {
		expect(classifyTransition("seeding", "error")).toBe("errored");
		expect(classifyTransition("downloading", "error")).toBe("errored");
	});

	it("flags a crossing into stalled_dl", () => {
		expect(classifyTransition("downloading", "stalled_dl")).toBe("stalled");
	});

	it("treats null/undefined prior state as a fresh crossing", () => {
		// A newly-correlated torrent that's already in a problem state IS
		// worth notifying — the operator hasn't seen it before.
		expect(classifyTransition(null, "error")).toBe("errored");
		expect(classifyTransition(undefined, "stalled_dl")).toBe("stalled");
	});

	it("does NOT re-flag a torrent that STAYS in the problem state", () => {
		// This is the anti-spam guarantee: error→error is not a transition,
		// so a torrent broken for days notifies exactly once.
		expect(classifyTransition("error", "error")).toBeNull();
		expect(classifyTransition("stalled_dl", "stalled_dl")).toBeNull();
	});

	it("returns null for healthy and recovery transitions", () => {
		expect(classifyTransition("seeding", "seeding")).toBeNull();
		expect(classifyTransition("downloading", "seeding")).toBeNull();
		// Recovery: error → seeding is good news, not a problem notification.
		expect(classifyTransition("error", "seeding")).toBeNull();
	});

	it("flags error→stalled_dl and stalled_dl→error as new crossings", () => {
		// Moving between two distinct problem states is a fresh problem of
		// the new kind — the operator should know the nature changed.
		expect(classifyTransition("error", "stalled_dl")).toBe("stalled");
		expect(classifyTransition("stalled_dl", "error")).toBe("errored");
	});
});

describe("buildNotificationPayloads", () => {
	const mk = (
		kind: ProblemTransition["kind"],
		title: string,
		infoHash = `hash-${title}`,
	): ProblemTransition => ({
		kind,
		infoHash,
		title,
		instanceLabel: "Primary qui",
		oldState: "seeding",
		newState: kind === "errored" ? "error" : "stalled_dl",
	});

	it("returns no payloads for an empty transition list", () => {
		expect(buildNotificationPayloads([])).toEqual([]);
	});

	it("emits one individual payload per transition below the threshold", () => {
		const transitions = [mk("errored", "Show A"), mk("errored", "Show B")];
		const payloads = buildNotificationPayloads(transitions);
		expect(payloads).toHaveLength(2);
		expect(payloads.every((p) => p.eventType === "QUI_TORRENT_ERRORED")).toBe(true);
		expect(payloads[0]?.metadata.aggregate).toBe(false);
		expect(payloads[0]?.title).toBe("Torrent errored: Show A");
		expect(payloads[0]?.metadata.infoHash).toBe("hash-Show A");
	});

	it("collapses to ONE aggregate payload when a kind exceeds the threshold", () => {
		// AGGREGATE_THRESHOLD + 1 transitions of one kind → single summary.
		const transitions = Array.from({ length: AGGREGATE_THRESHOLD + 1 }, (_, i) =>
			mk("errored", `Show ${i}`),
		);
		const payloads = buildNotificationPayloads(transitions);
		expect(payloads).toHaveLength(1);
		expect(payloads[0]?.metadata.aggregate).toBe(true);
		expect(payloads[0]?.metadata.count).toBe(AGGREGATE_THRESHOLD + 1);
		expect(payloads[0]?.title).toBe(`${AGGREGATE_THRESHOLD + 1} torrents errored`);
		expect(payloads[0]?.eventType).toBe("QUI_TORRENT_ERRORED");
	});

	it("groups by kind — errored and stalled never merge into one payload", () => {
		const transitions = [mk("errored", "Errored Show"), mk("stalled", "Stalled Show")];
		const payloads = buildNotificationPayloads(transitions);
		expect(payloads).toHaveLength(2);
		const byEvent = new Set(payloads.map((p) => p.eventType));
		expect(byEvent).toEqual(new Set(["QUI_TORRENT_ERRORED", "QUI_DOWNLOAD_STALLED"]));
	});

	it("applies the aggregate threshold independently per kind", () => {
		// 6 errored (aggregate) + 2 stalled (individual) → 1 + 2 = 3 payloads.
		const transitions = [
			...Array.from({ length: AGGREGATE_THRESHOLD + 1 }, (_, i) => mk("errored", `E${i}`)),
			mk("stalled", "S1"),
			mk("stalled", "S2"),
		];
		const payloads = buildNotificationPayloads(transitions);
		expect(payloads).toHaveLength(3);
		const aggregate = payloads.filter((p) => p.metadata.aggregate === true);
		const individual = payloads.filter((p) => p.metadata.aggregate === false);
		expect(aggregate).toHaveLength(1);
		expect(individual).toHaveLength(2);
	});

	it("aggregate body samples the first five titles", () => {
		const transitions = Array.from({ length: 9 }, (_, i) => mk("stalled", `Title ${i}`));
		const payloads = buildNotificationPayloads(transitions);
		expect(payloads).toHaveLength(1);
		expect(payloads[0]?.metadata.sampleTitles).toEqual([
			"Title 0",
			"Title 1",
			"Title 2",
			"Title 3",
			"Title 4",
		]);
		// Body indicates there's more beyond the sample.
		expect(payloads[0]?.body).toContain("…");
	});
});
