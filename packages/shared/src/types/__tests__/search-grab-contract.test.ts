import { describe, expect, it } from "vitest";

const intentId = "770ecb14-0000-4000-8000-000000000001";
const request = {
	instanceId: "synthetic-instance",
	intentId,
	selector: `sg1.${"A".repeat(16)}.${"A".repeat(23)}`,
};
const status = {
	attemptId: "770ecb14-0000-4000-8000-000000000002",
	intentId,
	state: "acknowledged",
	requestedAt: "2026-10-10T01:00:00.000Z",
	dispatchedAt: "2026-10-10T01:00:01.000Z",
	completedAt: "2026-10-10T01:00:02.000Z",
	outcomeCategory: null,
	nextAction: "none",
};
describe("durable Search Grab public contracts", () => {
	it("accepts only opaque provenance, intent and explicit confirmation", async () => {
		const { searchGrabRequestSchema } = await import("../search.js");
		expect(searchGrabRequestSchema.parse(request)).toEqual(request);
		expect(
			searchGrabRequestSchema.parse({
				...request,
				retry: { predecessorId: status.attemptId, duplicateRiskConfirmed: true },
			}).retry,
		).toEqual({ predecessorId: status.attemptId, duplicateRiskConfirmed: true });
	});
	it.each([
		{
			instanceId: request.instanceId,
			result: {
				id: "synthetic",
				title: "Synthetic",
				indexer: "Synthetic",
				indexerId: 7,
				protocol: "torrent",
			},
		},
		{ ...request, result: {} },
		{ ...request, guid: "synthetic" },
		{ ...request, intentId: "not-a-uuid" },
		{ ...request, selector: "forged-format" },
		{ ...request, selector: "x".repeat(16_385) },
		{ ...request, retry: { predecessorId: status.attemptId, duplicateRiskConfirmed: false } },
		{ ...request, retry: { predecessorId: status.attemptId } },
	])("refuses legacy, forged or ambiguous request %#", async (value) => {
		const { searchGrabRequestSchema } = await import("../search.js");
		expect(searchGrabRequestSchema.safeParse(value).success).toBe(false);
	});
	it("retains only strict generic status fields", async () => {
		const { searchGrabStatusSchema } = await import("../search.js");
		expect(searchGrabStatusSchema.parse(status)).toEqual(status);
		expect(searchGrabStatusSchema.safeParse({ ...status, guid: "private-target" }).success).toBe(
			false,
		);
	});
	it.each([
		{ ...status, state: "accepted" },
		{ ...status, outcomeCategory: "private-diagnostic" },
		{ ...status, dispatchedAt: null },
		{ ...status, completedAt: null },
		{ ...status, nextAction: "submit-now" },
		{ ...status, state: "uncertain", nextAction: "none" },
		{ ...status, requestedAt: "not-a-date" },
		{ ...status, completedAt: "2026-10-10T00:59:00.000Z" },
	])("refuses false or inconsistent public status %#", async (value) => {
		const { searchGrabStatusSchema } = await import("../search.js");
		expect(searchGrabStatusSchema.safeParse(value).success).toBe(false);
	});
});

describe("bounded result status lookup contracts", () => {
	const result = { instanceId: request.instanceId, selector: request.selector };
	it("accepts a bounded body without dispatch intent or raw target identity", async () => {
		const { searchGrabResultStatusRequestSchema } = await import("../search.js");
		expect(searchGrabResultStatusRequestSchema.parse({ results: [result] })).toEqual({
			results: [result],
		});
		expect(
			searchGrabResultStatusRequestSchema.parse({
				results: Array.from({ length: 50 }, () => result),
			}).results,
		).toHaveLength(50);
	});
	it.each([
		{ results: [] },
		{ results: Array.from({ length: 51 }, () => result) },
		{ results: [{ ...result, intentId }] },
		{ results: [{ ...result, guid: "private-target" }] },
		{ results: [{ ...result, selector: "forged-format" }] },
		{ results: [{ ...result, instanceId: "" }] },
		{ results: [{ ...result, selector: "x".repeat(16_385) }] },
		{ results: [result], retry: true },
	])("refuses unbounded or dispatch-shaped lookup %#", async (value) => {
		const { searchGrabResultStatusRequestSchema } = await import("../search.js");
		expect(searchGrabResultStatusRequestSchema.safeParse(value).success).toBe(false);
	});
	it("distinguishes recorded, not-recorded and unavailable without private correlation fields", async () => {
		const { searchGrabResultStatusResponseSchema } = await import("../search.js");
		const value = {
			results: [
				{ resultIndex: 0, availability: "recorded", status },
				{ resultIndex: 1, availability: "not-recorded", status: null },
				{ resultIndex: 2, availability: "unavailable", status: null },
			],
		};
		expect(searchGrabResultStatusResponseSchema.parse(value)).toEqual(value);
	});
	it.each([
		{ results: [{ resultIndex: 0, availability: "not-recorded", status }] },
		{ results: [{ resultIndex: 0, availability: "recorded", status: null }] },
		{ results: [{ resultIndex: 1, availability: "not-recorded", status: null }] },
		{
			results: [
				{ resultIndex: 0, availability: "unavailable", status: null, selector: result.selector },
			],
		},
		{ results: [{ resultIndex: 0, availability: "not-delivered", status: null }] },
	])("refuses false evidence or unsafe correlation %#", async (value) => {
		const { searchGrabResultStatusResponseSchema } = await import("../search.js");
		expect(searchGrabResultStatusResponseSchema.safeParse(value).success).toBe(false);
	});
});
