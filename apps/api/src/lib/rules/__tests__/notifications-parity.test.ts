/**
 * Notifications parity — legacy condition matching vs the engine-backed
 * adapter (unified-rule-grammar §4 step 5).
 *
 * The legacy reference is `matchNotificationCondition` composed with
 * Array.every (what RuleEngine.matchesAllConditions did before the
 * cutover); the adapter must agree on the full operator matrix,
 * including the REAL sharp edge this work corrected in the design doc:
 * an absent field fails EVERY operator (incl. not_equals) — there is
 * no String(undefined)→"undefined" coercion.
 */

import { describe, expect, it } from "vitest";
import {
	matchNotificationCondition,
	type RuleCondition,
} from "../../notifications/condition-matcher.js";
import type { NotificationPayload } from "../../notifications/types.js";
import { notificationConditionsMatchViaEngine } from "../notifications-adapter.js";

function payload(overrides: Partial<NotificationPayload> = {}): NotificationPayload {
	return {
		eventType: "HUNT_COMPLETED" as NotificationPayload["eventType"],
		title: "Hunt finished on Primary Sonarr",
		body: "Found 3 items",
		metadata: { instanceName: "Primary Sonarr", itemCount: 3 },
		...overrides,
	};
}

/** Legacy reference: flat implicit AND, exactly as the pre-cutover private method. */
function legacyMatches(p: NotificationPayload, conditions: RuleCondition[]): boolean {
	return conditions.every((cond) => matchNotificationCondition(p, cond));
}

function assertParity(p: NotificationPayload, conditions: RuleCondition[]): boolean {
	const legacy = legacyMatches(p, conditions);
	const engine = notificationConditionsMatchViaEngine(p, conditions);
	expect(engine).toBe(legacy);
	return legacy;
}

describe("notifications parity — operator matrix", () => {
	it("equals is case-SENSITIVE", () => {
		expect(
			assertParity(payload(), [
				{ field: "eventType", operator: "equals", value: "HUNT_COMPLETED" },
			]),
		).toBe(true);
		expect(
			assertParity(payload(), [
				{ field: "eventType", operator: "equals", value: "hunt_completed" },
			]),
		).toBe(false);
	});

	it("contains is case-INsensitive", () => {
		expect(
			assertParity(payload(), [{ field: "title", operator: "contains", value: "SONARR" }]),
		).toBe(true);
	});

	it("not_equals on a present field", () => {
		expect(
			assertParity(payload(), [
				{ field: "eventType", operator: "not_equals", value: "BACKUP_FAILED" },
			]),
		).toBe(true);
	});

	it("greater_than coerces numerically", () => {
		expect(
			assertParity(payload(), [
				{ field: "metadata.itemCount", operator: "greater_than", value: 2 },
			]),
		).toBe(true);
		expect(
			assertParity(payload(), [
				{ field: "metadata.itemCount", operator: "greater_than", value: "5" },
			]),
		).toBe(false);
	});

	it("in matches against a string array; non-array value is false", () => {
		expect(
			assertParity(payload(), [
				{ field: "eventType", operator: "in", value: ["HUNT_COMPLETED", "HUNT_FAILED"] },
			]),
		).toBe(true);
		expect(
			assertParity(payload(), [{ field: "eventType", operator: "in", value: "HUNT_COMPLETED" }]),
		).toBe(false);
	});
});

describe("notifications parity — the REAL absent-field sharp edge", () => {
	it("absent metadata key fails equals AND not_equals alike", () => {
		expect(
			assertParity(payload(), [{ field: "metadata.missing", operator: "equals", value: "x" }]),
		).toBe(false);
		// The edge: not_equals does NOT match absent fields either.
		expect(
			assertParity(payload(), [{ field: "metadata.missing", operator: "not_equals", value: "x" }]),
		).toBe(false);
	});

	it("absent field never coerces to the string 'undefined'", () => {
		expect(
			assertParity(payload(), [
				{ field: "metadata.missing", operator: "equals", value: "undefined" },
			]),
		).toBe(false);
	});

	it("payload with no metadata at all — metadata.* fields are absent", () => {
		expect(
			assertParity(payload({ metadata: undefined }), [
				{ field: "metadata.instanceName", operator: "not_equals", value: "X" },
			]),
		).toBe(false);
	});

	it("unknown top-level field is absent", () => {
		expect(assertParity(payload(), [{ field: "url", operator: "equals", value: "x" }])).toBe(false);
	});
});

describe("notifications parity — composition", () => {
	it("empty conditions array matches every event (vacuous truth)", () => {
		expect(assertParity(payload(), [])).toBe(true);
	});

	it("implicit AND — all must match", () => {
		expect(
			assertParity(payload(), [
				{ field: "eventType", operator: "equals", value: "HUNT_COMPLETED" },
				{ field: "title", operator: "contains", value: "sonarr" },
			]),
		).toBe(true);
		expect(
			assertParity(payload(), [
				{ field: "eventType", operator: "equals", value: "HUNT_COMPLETED" },
				{ field: "title", operator: "contains", value: "radarr" },
			]),
		).toBe(false);
	});
});
