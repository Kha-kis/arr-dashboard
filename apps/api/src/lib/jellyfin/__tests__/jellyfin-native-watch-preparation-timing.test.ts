import { describe, expect, it, vi } from "vitest";
import {
	createNativeWatchPreparationTiming,
	sanitizeNativeWatchPreparationTiming,
} from "../jellyfin-native-watch-preparation-timing.js";

const empty = () => ({
	requested: 0,
	callbackEntered: 0,
	succeeded: 0,
	failed: 0,
	refusedStart: 0,
	callbackFailed: 0,
	admissionTotalMs: 0,
	admissionMaxMs: 0,
	callbackToSuccessTotalMs: 0,
	callbackToSuccessMaxMs: 0,
	refusedStartTotalMs: 0,
	refusedStartMaxMs: 0,
	callbackToFailureTotalMs: 0,
	callbackToFailureMaxMs: 0,
});
const success = () => ({
	...empty(),
	requested: 1,
	callbackEntered: 1,
	succeeded: 1,
	admissionTotalMs: 10,
	admissionMaxMs: 10,
	callbackToSuccessTotalMs: 40,
	callbackToSuccessMaxMs: 40,
});
const valid = () => ({
	version: 1,
	transactions: { "row-chunk": success(), "receipt-chunk": empty(), "lease-checkpoint": empty() },
});
function fixture() {
	let time = 0;
	const collector = createNativeWatchPreparationTiming(() => time);
	return {
		collector,
		event(at: number, phase: string, kind = "row-chunk") {
			time = at;
			collector.observe({ kind, phase });
		},
	};
}

describe("native watch preparation timing", () => {
	it("separates literal 10ms admission and 40ms callback including commit", () => {
		const f = fixture();
		f.event(0, "requested");
		f.event(10, "callback-entered");
		f.event(50, "succeeded");
		expect(f.collector.snapshot()).toEqual(valid());
	});
	it("retains refused starts, retries, and failed callbacks in separate intervals", () => {
		const f = fixture();
		f.event(0, "requested");
		f.event(25, "failed");
		f.event(30, "requested");
		f.event(40, "callback-entered");
		f.event(65, "failed");
		f.event(70, "requested");
		f.event(80, "callback-entered");
		f.event(120, "succeeded");
		expect(f.collector.snapshot()).toEqual({
			...valid(),
			transactions: {
				...valid().transactions,
				"row-chunk": {
					requested: 3,
					callbackEntered: 2,
					succeeded: 1,
					failed: 2,
					refusedStart: 1,
					callbackFailed: 1,
					admissionTotalMs: 20,
					admissionMaxMs: 10,
					callbackToSuccessTotalMs: 40,
					callbackToSuccessMaxMs: 40,
					refusedStartTotalMs: 25,
					refusedStartMaxMs: 25,
					callbackToFailureTotalMs: 25,
					callbackToFailureMaxMs: 25,
				},
			},
		});
	});
	it("aggregates known kinds independently and rounds only at snapshot", () => {
		const f = fixture();
		f.event(0, "requested");
		f.event(0.4, "callback-entered");
		f.event(0.8, "succeeded");
		f.event(1, "requested");
		f.event(1.4, "callback-entered");
		f.event(1.8, "succeeded");
		f.event(2, "requested", "receipt-chunk");
		f.event(12, "callback-entered", "receipt-chunk");
		f.event(52, "succeeded", "receipt-chunk");
		f.event(53, "requested", "lease-checkpoint");
		f.event(63, "callback-entered", "lease-checkpoint");
		f.event(103, "succeeded", "lease-checkpoint");
		expect(f.collector.snapshot()).toEqual({
			version: 1,
			transactions: {
				"row-chunk": {
					...empty(),
					requested: 2,
					callbackEntered: 2,
					succeeded: 2,
					admissionTotalMs: 1,
					admissionMaxMs: 0,
					callbackToSuccessTotalMs: 1,
					callbackToSuccessMaxMs: 0,
				},
				"receipt-chunk": success(),
				"lease-checkpoint": success(),
			},
		});
	});
	it("omits no-event and incomplete streams", () => {
		const f = fixture();
		expect(f.collector.snapshot()).toBeUndefined();
		f.event(0, "requested");
		expect(f.collector.snapshot()).toBeUndefined();
	});
	it.each([
		[
			"duplicate request",
			[
				[0, "requested"],
				[1, "requested"],
			],
		],
		[
			"duplicate entry",
			[
				[0, "requested"],
				[1, "callback-entered"],
				[2, "callback-entered"],
			],
		],
		["out of order", [[0, "succeeded"]]],
		[
			"backwards",
			[
				[10, "requested"],
				[9, "callback-entered"],
				[20, "succeeded"],
			],
		],
		["unknown kind", [[0, "requested", "private-value"]]],
		["unknown phase", [[0, "private-phase"]]],
		[
			"overlap",
			[
				[0, "requested"],
				[1, "requested", "receipt-chunk"],
			],
		],
		[
			"nonfinite",
			[
				[0, "requested"],
				[Number.NaN, "callback-entered"],
				[20, "succeeded"],
			],
		],
		[
			"overflow",
			[
				[0, "requested"],
				[Number.MAX_SAFE_INTEGER + 1, "callback-entered"],
				[Number.MAX_SAFE_INTEGER + 2, "succeeded"],
			],
		],
	] as const)("omits %s without throwing", (_name, events) => {
		const f = fixture();
		expect(() => {
			for (const [time, phase, kind] of events) f.event(time, phase, kind);
		}).not.toThrow();
		expect(f.collector.snapshot()).toBeUndefined();
	});
	it("contains clock failures and never invokes hostile event accessors", () => {
		const collector = createNativeWatchPreparationTiming(() => {
			throw Error("private");
		});
		expect(() => collector.observe({ kind: "row-chunk", phase: "requested" })).not.toThrow();
		expect(collector.snapshot()).toBeUndefined();
		const getter = vi.fn(() => {
			throw Error("private");
		});
		const f = fixture();
		f.collector.observe(Object.defineProperty({}, "kind", { get: getter }));
		expect(getter).not.toHaveBeenCalled();
		expect(f.collector.snapshot()).toBeUndefined();
	});
});

describe("native preparation timing sanitizer", () => {
	it("rebuilds complete numeric metrics while discarding unknown private fields", () => {
		const input = valid();
		Object.assign(input, { privateValue: "must-not-cross" });
		Object.assign(input.transactions, { privateKind: "must-not-cross" });
		Object.assign(input.transactions["row-chunk"], { privateValue: "must-not-cross" });
		const sanitized = sanitizeNativeWatchPreparationTiming(input);
		expect(sanitized).toEqual(valid());
		expect(sanitized).not.toBe(input);
		expect(JSON.stringify(sanitized)).not.toContain("must-not-cross");
	});
	it.each([undefined, null, {}, { version: 2 }, { ...valid(), transactions: {} }])(
		"omits absent or incomplete metric %j",
		(value) => {
			expect(sanitizeNativeWatchPreparationTiming(value)).toBeUndefined();
		},
	);
	it.each([-1, Number.NaN, Number.POSITIVE_INFINITY, Number.MAX_SAFE_INTEGER + 1, 1.2, "10"])(
		"omits invalid numeric field %j",
		(value) => {
			const input = valid();
			Object.assign(input.transactions["row-chunk"], { admissionTotalMs: value });
			expect(sanitizeNativeWatchPreparationTiming(input)).toBeUndefined();
		},
	);
	it.each([
		{ requested: 2 },
		{ callbackEntered: 0 },
		{ failed: 1 },
		{ admissionMaxMs: 11 },
		{ callbackToSuccessMaxMs: 41 },
		{ refusedStartMaxMs: 1 },
		{ callbackToFailureMaxMs: 1 },
	])("omits inconsistent counters or maxima %j", (change) => {
		const input = valid();
		Object.assign(input.transactions["row-chunk"], change);
		expect(sanitizeNativeWatchPreparationTiming(input)).toBeUndefined();
	});
	it("does not invoke accessors, coercion, serialization hooks, or throwing proxy traps", () => {
		const getter = vi.fn(() => {
			throw Error("private");
		});
		const input = valid();
		Object.defineProperty(input.transactions["row-chunk"], "requested", { get: getter });
		expect(sanitizeNativeWatchPreparationTiming(input)).toBeUndefined();
		expect(getter).not.toHaveBeenCalled();
		expect(
			sanitizeNativeWatchPreparationTiming(new Proxy({}, { getOwnPropertyDescriptor: getter })),
		).toBeUndefined();
		const hooks = { valueOf: getter, toJSON: getter, toString: getter };
		const coercionInput = valid();
		Object.assign(coercionInput.transactions["row-chunk"], { requested: hooks });
		expect(sanitizeNativeWatchPreparationTiming(coercionInput)).toBeUndefined();
		expect(getter).toHaveBeenCalledTimes(1);
	});
});
