import { describe, expect, it, beforeEach } from "vitest";
import { schemaFingerprints } from "../schema-fingerprint.js";

const mockLog = {
	warn: () => {},
	error: () => {},
};

describe("SchemaFingerprintRegistry", () => {
	beforeEach(() => {
		schemaFingerprints.reset();
	});

	it("establishes baseline on first record", () => {
		const items = [
			{ name: "foo", score: 10 },
			{ name: "bar", score: 20 },
		];

		const drift = schemaFingerprints.record("test", "items", items, mockLog);

		expect(drift.hasDrift).toBe(false);
		expect(drift.newFields).toEqual([]);
		expect(drift.missingFields).toEqual([]);

		const fp = schemaFingerprints.get("test", "items");
		expect(fp).toBeDefined();
		expect(fp!.baseline.fields).toEqual(["name", "score"]);
		expect(fp!.baseline.sampleCount).toBe(2);
	});

	it("detects new fields added upstream", () => {
		const baseline = [{ name: "foo", score: 10 }];
		const updated = [{ name: "foo", score: 10, newField: "surprise" }];

		schemaFingerprints.record("test", "items", baseline, mockLog);
		const drift = schemaFingerprints.record("test", "items", updated, mockLog);

		expect(drift.hasDrift).toBe(true);
		expect(drift.newFields).toEqual(["newField"]);
		expect(drift.missingFields).toEqual([]);
	});

	it("grows baseline union when new fields appear", () => {
		schemaFingerprints.record("test", "items", [{ a: 1 }], mockLog);
		schemaFingerprints.record("test", "items", [{ a: 1, b: 2 }], mockLog);

		const fp = schemaFingerprints.get("test", "items");
		// Baseline should now include both a and b
		expect(fp!.baseline.fields).toEqual(["a", "b"]);
	});

	it("does NOT flag missing fields after 1-2 consecutive absences", () => {
		const baseline = [{ name: "foo", score: 10, description: "test" }];
		const updated = [{ name: "foo", score: 10 }]; // description absent

		schemaFingerprints.record("test", "items", baseline, mockLog);

		// 1st absence — no missing drift
		let drift = schemaFingerprints.record("test", "items", updated, mockLog);
		expect(drift.missingFields).toEqual([]);

		// 2nd absence — still no missing drift
		drift = schemaFingerprints.record("test", "items", updated, mockLog);
		expect(drift.missingFields).toEqual([]);
	});

	it("flags missing fields after 3 consecutive absences", () => {
		const baseline = [{ name: "foo", score: 10, description: "test" }];
		const updated = [{ name: "foo", score: 10 }]; // description absent

		schemaFingerprints.record("test", "items", baseline, mockLog);
		schemaFingerprints.record("test", "items", updated, mockLog); // miss 1
		schemaFingerprints.record("test", "items", updated, mockLog); // miss 2
		const drift = schemaFingerprints.record("test", "items", updated, mockLog); // miss 3

		expect(drift.hasDrift).toBe(true);
		expect(drift.missingFields).toEqual(["description"]);
	});

	it("resets miss counter when field reappears", () => {
		const baseline = [{ name: "foo", opt: "present" }];
		const absent = [{ name: "foo" }];
		const present = [{ name: "foo", opt: "back" }];

		schemaFingerprints.record("test", "items", baseline, mockLog);
		schemaFingerprints.record("test", "items", absent, mockLog); // miss 1
		schemaFingerprints.record("test", "items", absent, mockLog); // miss 2

		// Field reappears — should reset counter
		schemaFingerprints.record("test", "items", present, mockLog);

		// 1 more absence — counter should be at 1 (reset from 2), not 3
		const drift = schemaFingerprints.record("test", "items", absent, mockLog);
		expect(drift.missingFields).toEqual([]);
	});

	it("detects new fields and missing fields simultaneously (with threshold)", () => {
		const baseline = [{ name: "foo", oldField: true }];
		const updated = [{ name: "foo", newField: "added" }]; // oldField absent

		schemaFingerprints.record("test", "items", baseline, mockLog);

		// First absence — new field detected, but missing not yet (threshold not met)
		let drift = schemaFingerprints.record("test", "items", updated, mockLog);
		expect(drift.newFields).toEqual(["newField"]);
		expect(drift.missingFields).toEqual([]); // only 1 miss

		// 2 more absences to reach threshold
		schemaFingerprints.record("test", "items", updated, mockLog);
		drift = schemaFingerprints.record("test", "items", updated, mockLog); // miss 3

		expect(drift.missingFields).toEqual(["oldField"]);
	});

	it("unions fields across all items in a batch", () => {
		const items = [
			{ name: "foo" },
			{ name: "bar", score: 10 },
			{ name: "baz", description: "test" },
		];

		schemaFingerprints.record("test", "items", items, mockLog);
		const fp = schemaFingerprints.get("test", "items");

		expect(fp!.baseline.fields).toEqual(["description", "name", "score"]);
	});

	it("returns no drift when schema is stable", () => {
		const items = [{ name: "foo", score: 10 }];

		schemaFingerprints.record("test", "items", items, mockLog);
		const drift = schemaFingerprints.record("test", "items", items, mockLog);

		expect(drift.hasDrift).toBe(false);
	});

	it("getByIntegration returns all categories for an integration", () => {
		schemaFingerprints.record("plex", "sessions", [{ id: 1 }], mockLog);
		schemaFingerprints.record("plex", "history", [{ title: "test" }], mockLog);
		schemaFingerprints.record("tautulli", "activity", [{ stream: true }], mockLog);

		const plexFps = schemaFingerprints.getByIntegration("plex");

		expect(Object.keys(plexFps)).toEqual(["sessions", "history"]);
		expect(plexFps.sessions!.baseline.fields).toEqual(["id"]);
		expect(plexFps.history!.baseline.fields).toEqual(["title"]);
	});

	it("getAll returns grouped by integration", () => {
		schemaFingerprints.record("plex", "sessions", [{ id: 1 }], mockLog);
		schemaFingerprints.record("tautulli", "activity", [{ stream: true }], mockLog);

		const all = schemaFingerprints.getAll();

		expect(Object.keys(all)).toEqual(["plex", "tautulli"]);
		expect(Object.keys(all.plex!)).toEqual(["sessions"]);
		expect(Object.keys(all.tautulli!)).toEqual(["activity"]);
	});

	it("resetIntegration clears only that integration", () => {
		schemaFingerprints.record("plex", "sessions", [{ id: 1 }], mockLog);
		schemaFingerprints.record("tautulli", "activity", [{ stream: true }], mockLog);

		schemaFingerprints.resetIntegration("plex");

		expect(schemaFingerprints.get("plex", "sessions")).toBeUndefined();
		expect(schemaFingerprints.get("tautulli", "activity")).toBeDefined();
	});

	it("ignores non-object items in fingerprinting", () => {
		const items = ["string", 42, null, { name: "foo" }];

		schemaFingerprints.record("test", "items", items, mockLog);
		const fp = schemaFingerprints.get("test", "items");

		expect(fp!.baseline.fields).toEqual(["name"]);
	});

	it("logs warning for new fields immediately", () => {
		const warnings: string[] = [];
		const logSpy = {
			warn: (msg: string | object) => { warnings.push(String(msg)); },
			error: () => {},
		};

		schemaFingerprints.record("test", "items", [{ a: 1, b: 2 }], logSpy);
		schemaFingerprints.record("test", "items", [{ a: 1, c: 3 }], logSpy);

		// Should log new field warning for c
		expect(warnings).toHaveLength(1);
		expect(warnings[0]).toContain("new fields detected: c");
	});

	it("logs warning for missing fields only after threshold", () => {
		const warnings: string[] = [];
		const logSpy = {
			warn: (msg: string | object) => { warnings.push(String(msg)); },
			error: () => {},
		};

		schemaFingerprints.record("test", "items", [{ a: 1, b: 2 }], logSpy);

		// 3 consecutive absences of b
		schemaFingerprints.record("test", "items", [{ a: 1 }], logSpy);
		schemaFingerprints.record("test", "items", [{ a: 1 }], logSpy);
		schemaFingerprints.record("test", "items", [{ a: 1 }], logSpy);

		const missingWarnings = warnings.filter((w) => w.includes("missing fields"));
		expect(missingWarnings).toHaveLength(1);
		expect(missingWarnings[0]).toContain("b");
	});

	it("exposes fieldMissCounts in CategoryFingerprint", () => {
		schemaFingerprints.record("test", "items", [{ a: 1, b: 2 }], mockLog);
		schemaFingerprints.record("test", "items", [{ a: 1 }], mockLog); // b miss 1
		schemaFingerprints.record("test", "items", [{ a: 1 }], mockLog); // b miss 2

		const fp = schemaFingerprints.get("test", "items");
		expect(fp!.fieldMissCounts.b).toBe(2);
	});
});
