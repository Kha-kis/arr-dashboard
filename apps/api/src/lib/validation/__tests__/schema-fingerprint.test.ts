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

	it("detects missing fields (potential breaking change)", () => {
		const baseline = [{ name: "foo", score: 10, description: "test" }];
		const updated = [{ name: "foo", score: 10 }];

		schemaFingerprints.record("test", "items", baseline, mockLog);
		const drift = schemaFingerprints.record("test", "items", updated, mockLog);

		expect(drift.hasDrift).toBe(true);
		expect(drift.newFields).toEqual([]);
		expect(drift.missingFields).toEqual(["description"]);
	});

	it("detects both new and missing fields simultaneously", () => {
		const baseline = [{ name: "foo", oldField: true }];
		const updated = [{ name: "foo", newField: "added" }];

		schemaFingerprints.record("test", "items", baseline, mockLog);
		const drift = schemaFingerprints.record("test", "items", updated, mockLog);

		expect(drift.hasDrift).toBe(true);
		expect(drift.newFields).toEqual(["newField"]);
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

	it("logs warning for new and missing fields", () => {
		const warnings: string[] = [];
		const logSpy = {
			warn: (msg: string | object) => { warnings.push(String(msg)); },
			error: () => {},
		};

		schemaFingerprints.record("test", "items", [{ a: 1, b: 2 }], logSpy);
		schemaFingerprints.record("test", "items", [{ a: 1, c: 3 }], logSpy);

		expect(warnings).toHaveLength(2);
		expect(warnings[0]).toContain("new fields detected: c");
		expect(warnings[1]).toContain("missing fields: b");
	});
});
