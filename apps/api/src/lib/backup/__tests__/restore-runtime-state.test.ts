import { describe, expect, it } from "vitest";
import {
	classifyRestoreRuntimeRecovery,
	parseRestoreRuntimeRecord,
	prepareRestoreRuntimeCommitRecord,
	RestoreRuntimeStateError,
} from "../restore-runtime-state.js";

const EPOCH = "11111111-1111-4111-8111-111111111111";
const RESTORE = "22222222-2222-4222-8222-222222222222";
const OLDER_RESTORE = "33333333-3333-4333-8333-333333333333";
const TIME = "2026-10-07T12:00:00.000Z";
const DESTINATION = "fixture-destination";

function record(patch: Record<string, unknown> = {}) {
	return {
		id: 1,
		protocolVersion: 1,
		phase: "idle",
		runtimeEpoch: null,
		ownerBackendPid: null,
		activeRestoreId: null,
		lastCommittedRestoreId: null,
		lastCommittedAt: null,
		destinationInstallationId: DESTINATION,
		...patch,
	};
}

function pending(patch: Record<string, unknown> = {}) {
	return record({
		phase: "restore-pending",
		runtimeEpoch: EPOCH,
		activeRestoreId: RESTORE,
		...patch,
	});
}

function request(patch: Record<string, unknown> = {}) {
	return {
		runtimeEpoch: EPOCH,
		restoreId: RESTORE,
		destinationInstallationId: DESTINATION,
		committedAt: TIME,
		...patch,
	};
}

function expectBoundedRefusal(run: () => unknown) {
	expect(run).toThrow(RestoreRuntimeStateError);
	try {
		run();
	} catch (error) {
		expect(error).toMatchObject({
			name: "RestoreRuntimeStateError",
			message: "Restore runtime state is unavailable.",
		});
		expect(error).not.toHaveProperty("cause");
		expect(error).not.toHaveProperty("record");
	}
}

describe("Restore runtime record codec", () => {
	it.each([
		["idle without identity or history", record({ destinationInstallationId: null })],
		[
			"idle with historical commit",
			record({ lastCommittedRestoreId: OLDER_RESTORE, lastCommittedAt: TIME }),
		],
		[
			"starting without resolved identity",
			record({ phase: "starting", runtimeEpoch: EPOCH, destinationInstallationId: null }),
		],
		[
			"starting with historical commit",
			record({
				phase: "starting",
				runtimeEpoch: EPOCH,
				lastCommittedRestoreId: OLDER_RESTORE,
				lastCommittedAt: TIME,
			}),
		],
		["running with SQLite PID", record({ phase: "running", runtimeEpoch: EPOCH })],
		[
			"running with historical commit",
			record({
				phase: "running",
				runtimeEpoch: EPOCH,
				lastCommittedRestoreId: OLDER_RESTORE,
				lastCommittedAt: TIME,
			}),
		],
		[
			"running with smallest PostgreSQL PID",
			record({ phase: "running", runtimeEpoch: EPOCH, ownerBackendPid: 1 }),
		],
		[
			"running with PostgreSQL PID",
			record({ phase: "running", runtimeEpoch: EPOCH, ownerBackendPid: 2147483647 }),
		],
		["pending without history", pending()],
		[
			"pending with different historical commit",
			pending({ lastCommittedRestoreId: OLDER_RESTORE, lastCommittedAt: TIME }),
		],
		[
			"pending with current positive marker",
			pending({ lastCommittedRestoreId: RESTORE, lastCommittedAt: TIME }),
		],
		[
			"restart required",
			pending({
				phase: "restart-required",
				lastCommittedRestoreId: RESTORE,
				lastCommittedAt: TIME,
			}),
		],
	])("accepts %s as immutable evidence, not ownership", (_name, input) => {
		const result = parseRestoreRuntimeRecord(input);
		expect(result).toEqual(input);
		expect(result).not.toBe(input);
		expect(Object.isFrozen(result)).toBe(true);
	});

	it("normalizes a Date without retaining mutable input", () => {
		const date = new Date(TIME);
		const input = Object.freeze(record({ lastCommittedRestoreId: RESTORE, lastCommittedAt: date }));
		const result = parseRestoreRuntimeRecord(input);
		expect(result.lastCommittedAt).toBe("2026-10-07T12:00:00.000Z");
		date.setUTCFullYear(2020);
		expect(result.lastCommittedAt).toBe("2026-10-07T12:00:00.000Z");
		expect(result).not.toBe(input);
		expect(() => Object.assign(result, { phase: "running" })).toThrow(TypeError);
	});

	it("accepts null-prototype own-data rows", () => {
		const input = Object.assign(Object.create(null), record());
		expect(parseRestoreRuntimeRecord(input)).toEqual(record());
	});

	it("does not unnecessarily restrict canonical UUIDs to version four", () => {
		const input = record({
			phase: "starting",
			runtimeEpoch: "12345678-1234-1234-1234-123456789abc",
		});
		expect(parseRestoreRuntimeRecord(input).runtimeEpoch).toBe(
			"12345678-1234-1234-1234-123456789abc",
		);
	});

	it("accepts the identity length boundary without changing identity", () => {
		const identity = ` ${"x".repeat(254)} `;
		expect(
			parseRestoreRuntimeRecord(record({ destinationInstallationId: identity }))
				.destinationInstallationId,
		).toBe(identity);
	});

	it.each([
		["wrong singleton", { id: 2 }],
		["coerced singleton", { id: "1" }],
		["future protocol", { protocolVersion: 2 }],
		["coerced protocol", { protocolVersion: "1" }],
		["unknown phase", { phase: "finished" }],
		["missing epoch", { phase: "starting" }],
		["malformed epoch", { phase: "starting", runtimeEpoch: "not-a-uuid" }],
		[
			"uppercase epoch",
			{ phase: "starting", runtimeEpoch: "aaaaaaaa-aaaa-4aaa-8aaa-aaaaaaaaaaaA" },
		],
		["idle epoch", { runtimeEpoch: EPOCH }],
		["idle PID", { ownerBackendPid: 1 }],
		["idle active ID", { activeRestoreId: RESTORE }],
		["zero PID", { phase: "running", runtimeEpoch: EPOCH, ownerBackendPid: 0 }],
		["negative PID", { phase: "running", runtimeEpoch: EPOCH, ownerBackendPid: -1 }],
		["fractional PID", { phase: "running", runtimeEpoch: EPOCH, ownerBackendPid: 1.5 }],
		["overflow PID", { phase: "running", runtimeEpoch: EPOCH, ownerBackendPid: 2147483648 }],
		["coerced PID", { phase: "running", runtimeEpoch: EPOCH, ownerBackendPid: "1" }],
		["NaN PID", { phase: "running", runtimeEpoch: EPOCH, ownerBackendPid: Number.NaN }],
		["running active ID", { phase: "running", runtimeEpoch: EPOCH, activeRestoreId: RESTORE }],
		["starting active ID", { phase: "starting", runtimeEpoch: EPOCH, activeRestoreId: RESTORE }],
		[
			"running without identity",
			{ phase: "running", runtimeEpoch: EPOCH, destinationInstallationId: null },
		],
		["empty identity", { destinationInstallationId: "" }],
		["blank identity", { destinationInstallationId: "  " }],
		["long identity", { destinationInstallationId: "x".repeat(257) }],
		["C0 identity", { destinationInstallationId: "fixture\nidentity" }],
		["C1 identity", { destinationInstallationId: "fixture\u0085identity" }],
		["non-string identity", { destinationInstallationId: 123 }],
		["marker without time", { lastCommittedRestoreId: RESTORE }],
		["time without marker", { lastCommittedAt: TIME }],
		["bad marker ID", { lastCommittedRestoreId: "private-invalid-value", lastCommittedAt: TIME }],
		["invalid Date", { lastCommittedRestoreId: RESTORE, lastCommittedAt: new Date(Number.NaN) }],
		["numeric time", { lastCommittedRestoreId: RESTORE, lastCommittedAt: 1791374400000 }],
		[
			"noncanonical time",
			{ lastCommittedRestoreId: RESTORE, lastCommittedAt: "2026-10-07T12:00:00Z" },
		],
		[
			"normalized invalid calendar day",
			{ lastCommittedRestoreId: RESTORE, lastCommittedAt: "2026-02-30T12:00:00.000Z" },
		],
		[
			"time offset",
			{ lastCommittedRestoreId: RESTORE, lastCommittedAt: "2026-10-07T12:00:00.000+00:00" },
		],
		[
			"historical marker without identity",
			{ destinationInstallationId: null, lastCommittedRestoreId: RESTORE, lastCommittedAt: TIME },
		],
		[
			"starting history without identity",
			{
				phase: "starting",
				runtimeEpoch: EPOCH,
				destinationInstallationId: null,
				lastCommittedRestoreId: RESTORE,
				lastCommittedAt: TIME,
			},
		],
		["pending without active ID", { phase: "restore-pending", runtimeEpoch: EPOCH }],
		[
			"pending without identity",
			{
				phase: "restore-pending",
				runtimeEpoch: EPOCH,
				activeRestoreId: RESTORE,
				destinationInstallationId: null,
			},
		],
		[
			"bad active ID",
			{ phase: "restore-pending", runtimeEpoch: EPOCH, activeRestoreId: "not-a-uuid" },
		],
		[
			"restart without commit",
			{ phase: "restart-required", runtimeEpoch: EPOCH, activeRestoreId: RESTORE },
		],
		[
			"restart with older marker",
			{
				phase: "restart-required",
				runtimeEpoch: EPOCH,
				activeRestoreId: RESTORE,
				lastCommittedRestoreId: OLDER_RESTORE,
				lastCommittedAt: TIME,
			},
		],
	])("rejects %s with a bounded generic error", (_name, patch) => {
		expectBoundedRefusal(() => parseRestoreRuntimeRecord(record(patch)));
	});

	it.each([null, undefined, [], "private-value", 1, true])("rejects non-record %s", (input) => {
		expectBoundedRefusal(() => parseRestoreRuntimeRecord(input));
	});

	it.each(Object.keys(record()))("requires explicit own field %s", (field) => {
		const input: Record<string, unknown> = record();
		delete input[field];
		expectBoundedRefusal(() => parseRestoreRuntimeRecord(input));
	});

	it.each(Object.keys(record()))(
		"does not coerce undefined field %s to null or a default",
		(field) => {
			expectBoundedRefusal(() => parseRestoreRuntimeRecord(record({ [field]: undefined })));
		},
	);

	it("rejects additional string and symbol fields", () => {
		expectBoundedRefusal(() =>
			parseRestoreRuntimeRecord({ ...record(), unexpected: "private-value" }),
		);
		expectBoundedRefusal(() => parseRestoreRuntimeRecord({ ...record(), [Symbol("extra")]: true }));
	});

	it("rejects inherited coordination fields and class instances", () => {
		expectBoundedRefusal(() => parseRestoreRuntimeRecord(Object.create(record())));
		class Row {
			id = 1;
		}
		expectBoundedRefusal(() => parseRestoreRuntimeRecord(Object.assign(new Row(), record())));
	});

	it("rejects accessors without evaluating private data", () => {
		let reads = 0;
		const input = record();
		Object.defineProperty(input, "phase", {
			enumerable: true,
			get() {
				reads++;
				throw new Error("private-value");
			},
		});
		expectBoundedRefusal(() => parseRestoreRuntimeRecord(input));
		expect(reads).toBe(0);
	});

	it("bounds reflective failures rather than forwarding their private cause", () => {
		const input = new Proxy(record(), {
			ownKeys() {
				throw new Error("private-value");
			},
		});
		expectBoundedRefusal(() => parseRestoreRuntimeRecord(input));
	});
});

describe("Restore recovery classification", () => {
	it.each([
		["idle", record(), "no-pending-restore"],
		["starting", record({ phase: "starting", runtimeEpoch: EPOCH }), "no-pending-restore"],
		[
			"running with history",
			record({
				phase: "running",
				runtimeEpoch: EPOCH,
				lastCommittedRestoreId: OLDER_RESTORE,
				lastCommittedAt: TIME,
			}),
			"no-pending-restore",
		],
		["pending without marker", pending(), "not-committed"],
		[
			"pending with older success",
			pending({ lastCommittedRestoreId: OLDER_RESTORE, lastCommittedAt: TIME }),
			"not-committed",
		],
		[
			"pending with current positive marker",
			pending({ lastCommittedRestoreId: RESTORE, lastCommittedAt: TIME }),
			"committed",
		],
		[
			"restart required",
			pending({
				phase: "restart-required",
				lastCommittedRestoreId: RESTORE,
				lastCommittedAt: TIME,
			}),
			"committed",
		],
	])("classifies %s without opening admission", (_name, input, expected) => {
		expect(classifyRestoreRuntimeRecovery(Object.freeze(input), DESTINATION)).toBe(expected);
	});

	it.each([
		null,
		record({ protocolVersion: 2 }),
		pending({ lastCommittedRestoreId: RESTORE }),
		record({ destinationInstallationId: null }),
	])("keeps unavailable evidence unavailable", (input) => {
		expect(classifyRestoreRuntimeRecovery(input, DESTINATION)).toBe("unavailable");
	});

	it.each(["other-destination", "", "  ", "x".repeat(257), "fixture\nidentity"])(
		"refuses invalid or mismatched current identity",
		(identity) => {
			expect(classifyRestoreRuntimeRecovery(pending(), identity)).toBe("unavailable");
		},
	);

	it("does not treat a mismatched destination's positive marker as current success", () => {
		expect(
			classifyRestoreRuntimeRecovery(
				pending({
					phase: "restart-required",
					lastCommittedRestoreId: RESTORE,
					lastCommittedAt: TIME,
				}),
				"other-destination",
			),
		).toBe("unavailable");
	});
});

describe("Prospective Restore commit marker", () => {
	it("requires matching pending context and preserves the owner session evidence", () => {
		const input = Object.freeze(
			pending({
				ownerBackendPid: 42,
				lastCommittedRestoreId: OLDER_RESTORE,
				lastCommittedAt: "2026-10-06T12:00:00.000Z",
			}),
		);
		const commit = Object.freeze(request());
		const result = prepareRestoreRuntimeCommitRecord(input, commit);
		expect(result).toEqual({
			id: 1,
			protocolVersion: 1,
			phase: "restart-required",
			runtimeEpoch: EPOCH,
			ownerBackendPid: 42,
			activeRestoreId: RESTORE,
			lastCommittedRestoreId: RESTORE,
			lastCommittedAt: "2026-10-07T12:00:00.000Z",
			destinationInstallationId: DESTINATION,
		});
		expect(input.phase).toBe("restore-pending");
		expect(input.lastCommittedRestoreId).toBe(OLDER_RESTORE);
		expect(input.lastCommittedAt).toBe("2026-10-06T12:00:00.000Z");
		expect(commit).toEqual({
			runtimeEpoch: EPOCH,
			restoreId: RESTORE,
			destinationInstallationId: DESTINATION,
			committedAt: TIME,
		});
		expect(result).not.toBe(input);
		expect(Object.isFrozen(result)).toBe(true);
	});

	it("normalizes explicit caller time without retaining its Date", () => {
		const date = new Date(TIME);
		const result = prepareRestoreRuntimeCommitRecord(pending(), {
			...request(),
			committedAt: date,
		});
		date.setUTCFullYear(2020);
		expect(result.lastCommittedAt).toBe("2026-10-07T12:00:00.000Z");
	});

	it.each([
		["stale epoch", { runtimeEpoch: OLDER_RESTORE }],
		["other active ID", { restoreId: OLDER_RESTORE }],
		["other destination", { destinationInstallationId: "other-destination" }],
		["invalid epoch", { runtimeEpoch: "private-value" }],
		["invalid active ID", { restoreId: "private-value" }],
		["blank destination", { destinationInstallationId: "  " }],
		["missing explicit time", { committedAt: undefined }],
		["null time", { committedAt: null }],
		["invalid Date", { committedAt: new Date(Number.NaN) }],
		["coerced time", { committedAt: 0 }],
		["noncanonical time", { committedAt: "2026-10-07T12:00:00Z" }],
		["unknown request field", { unexpected: "private-value" }],
	])("rejects %s without preparing success", (_name, patch) => {
		expectBoundedRefusal(() => prepareRestoreRuntimeCommitRecord(pending(), request(patch)));
	});

	it.each(Object.keys(request()))("requires explicit commit request field %s", (field) => {
		const input = request();
		Reflect.deleteProperty(input, field);
		expectBoundedRefusal(() => prepareRestoreRuntimeCommitRecord(pending(), input));
	});

	it("does not invoke a commit request time accessor", () => {
		let reads = 0;
		const input = request();
		Object.defineProperty(input, "committedAt", {
			get() {
				reads++;
				return TIME;
			},
		});
		expectBoundedRefusal(() => prepareRestoreRuntimeCommitRecord(pending(), input));
		expect(reads).toBe(0);
	});

	it.each([
		record(),
		record({ phase: "starting", runtimeEpoch: EPOCH }),
		record({ phase: "running", runtimeEpoch: EPOCH }),
		pending({ phase: "restart-required", lastCommittedRestoreId: RESTORE, lastCommittedAt: TIME }),
		pending({ protocolVersion: 2 }),
	])("refuses non-pending or malformed source record", (input) => {
		expectBoundedRefusal(() => prepareRestoreRuntimeCommitRecord(input, request()));
	});
});
