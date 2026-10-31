import { describe, expect, it } from "vitest";
import { multiInstanceSearchResponseSchema } from "./search.js";

const row = {
	id: "release",
	title: "Synthetic",
	indexer: "Indexer",
	indexerId: 7,
	protocol: "torrent",
	instanceId: "p-1",
	instanceName: "Prowlarr",
};
const coverage = {
	receivedCount: 2,
	acceptedCount: 1,
	rejectedCount: 1,
	metadataIncompleteCount: 0,
};
const envelope = {
	instances: [
		{ instanceId: "p-1", instanceName: "Prowlarr", success: true, data: [row], coverage },
	],
	aggregated: [row],
	totalCount: 1,
	failedInstanceCount: 0,
	coverage,
};

describe("Search returned-batch contract", () => {
	// Removing coverage from parsing silently erases the evidence callers need.
	it("retains literal coverage and metadata incompleteness", () => {
		const incomplete = { ...row, metadataIncomplete: true };
		const partial = { ...coverage, metadataIncompleteCount: 1 };
		const parsed = multiInstanceSearchResponseSchema.parse({
			...envelope,
			aggregated: [incomplete],
			coverage: partial,
			instances: [{ ...envelope.instances[0], data: [incomplete], coverage: partial }],
		});
		expect(parsed.coverage).toEqual({
			receivedCount: 2,
			acceptedCount: 1,
			rejectedCount: 1,
			metadataIncompleteCount: 1,
		});
		expect(parsed.aggregated[0]?.metadataIncomplete).toBe(true);
	});
	it("admits legacy arrays without certifying coverage", () => {
		const { coverage: _coverage, ...legacy } = envelope;
		const { coverage: _instanceCoverage, ...instance } = legacy.instances[0]!;
		expect(
			multiInstanceSearchResponseSchema.parse({ ...legacy, instances: [instance] }),
		).not.toHaveProperty("coverage");
	});
	it.each([
		["unbalanced", { ...coverage, receivedCount: 3 }],
		["negative", { ...coverage, rejectedCount: -1 }],
		["fractional", { ...coverage, acceptedCount: 0.5 }],
		["incomplete beyond accepted", { ...coverage, metadataIncompleteCount: 2 }],
		[
			"count differs from actual rows",
			{ receivedCount: 3, acceptedCount: 2, rejectedCount: 1, metadataIncompleteCount: 0 },
		],
	] as const)("rejects %s coverage", (_name, bad) => {
		expect(
			multiInstanceSearchResponseSchema.safeParse({
				...envelope,
				coverage: bad,
				instances: [{ ...envelope.instances[0], coverage: bad }],
			}).success,
		).toBe(false);
	});
	it.each([
		{ ...envelope, totalCount: 2 },
		{ ...envelope, aggregated: [] },
		{ ...envelope, aggregated: [{ ...row, instanceId: "foreign" }] },
		{
			...envelope,
			failedInstanceCount: 0,
			instances: [{ ...envelope.instances[0], success: false, data: [] }],
		},
		{ ...envelope, instances: [] },
		{ ...envelope, coverage: { ...coverage, metadataIncompleteCount: 1 } },
	])("rejects inconsistent accepted arrays and envelope totals %#", (bad) => {
		expect(multiInstanceSearchResponseSchema.safeParse(bad).success).toBe(false);
	});
});
