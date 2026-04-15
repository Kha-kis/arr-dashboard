/**
 * Unit tests for sortPulseItems — the route-level sort comparator that
 * determines the operator-visible order of Pulse items.
 *
 * The contract under test:
 *   (a) severity bucket first: critical > warning > info
 *   (b) within a severity bucket, NON-queue rows come before queue rows
 *       (queue deprioritization — so a bad download-client day can't
 *       drown a genuinely more-important system signal)
 *   (c) within the same severity + row class, newest timestamp first
 *
 * This is the automated equivalent of the "Needs Attention still
 * prioritizes system issues" manual check from the V1.1 test plan.
 */

import type { PulseItem } from "@arr/shared";
import { describe, expect, it } from "vitest";
import { sortPulseItems } from "../pulse.js";

function mkItem(overrides: Partial<PulseItem> & Pick<PulseItem, "id">): PulseItem {
	return {
		severity: "warning",
		category: "operations",
		title: "item",
		detail: "",
		source: "system",
		timestamp: "2026-01-01T00:00:00.000Z",
		...overrides,
	};
}

describe("sortPulseItems", () => {
	it("orders critical before warning before info", () => {
		const sorted = sortPulseItems([
			mkItem({ id: "info-1", severity: "info" }),
			mkItem({ id: "warn-1", severity: "warning" }),
			mkItem({ id: "crit-1", severity: "critical" }),
		]);
		expect(sorted.map((i) => i.id)).toEqual(["crit-1", "warn-1", "info-1"]);
	});

	it("pushes queue-* rows to the end of their severity bucket even when they have a newer timestamp", () => {
		// The queue row has the NEWEST timestamp of the group. On a naive
		// "newest first" sort it would show up first. The deprioritization
		// must override timestamp within the same severity so the system
		// rows (scheduler/ARR-health) stay above the queue flood.
		const sorted = sortPulseItems([
			mkItem({
				id: "queue-failed-inst-a-1",
				severity: "warning",
				timestamp: "2026-04-15T12:00:00.000Z",
			}),
			mkItem({
				id: "scheduler-disabled-hunting",
				severity: "warning",
				timestamp: "2026-04-15T08:00:00.000Z",
			}),
			mkItem({
				id: "arr-unreachable-inst-b",
				severity: "warning",
				timestamp: "2026-04-15T10:00:00.000Z",
			}),
		]);

		expect(sorted.map((i) => i.id)).toEqual([
			"arr-unreachable-inst-b", // non-queue, newer
			"scheduler-disabled-hunting", // non-queue, older
			"queue-failed-inst-a-1", // queue, last despite having newest timestamp
		]);
	});

	it("preserves newest-first order within the same severity + row class", () => {
		// Two queue rows in the same severity bucket: newest first wins.
		const sorted = sortPulseItems([
			mkItem({
				id: "queue-failed-inst-a-1",
				severity: "warning",
				timestamp: "2026-04-15T08:00:00.000Z",
			}),
			mkItem({
				id: "queue-failed-inst-a-2",
				severity: "warning",
				timestamp: "2026-04-15T12:00:00.000Z",
			}),
		]);
		expect(sorted.map((i) => i.id)).toEqual(["queue-failed-inst-a-2", "queue-failed-inst-a-1"]);
	});

	it("keeps critical queue rows above warning non-queue rows (severity dominates deprioritization)", () => {
		// Queue deprioritization only applies WITHIN a severity bucket. A
		// critical queue event (if any collector ever emits one) must still
		// beat a merely-warning system row. Regression guard for anyone
		// tempted to "always push queue rows to the bottom" globally.
		const sorted = sortPulseItems([
			mkItem({
				id: "scheduler-disabled-hunting",
				severity: "warning",
			}),
			mkItem({
				id: "queue-critical-inst-a-1",
				severity: "critical",
			}),
		]);
		expect(sorted.map((i) => i.id)).toEqual([
			"queue-critical-inst-a-1",
			"scheduler-disabled-hunting",
		]);
	});
});
