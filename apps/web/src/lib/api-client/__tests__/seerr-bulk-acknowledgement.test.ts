import { afterEach, describe, expect, it, vi } from "vitest";
import { ApiError, InvalidSuccessResponseError } from "../base";
import { bulkSeerrRequestAction } from "../seerr";

const privateDetail = "synthetic-private-bulk-diagnostic";
const success = {
	results: [
		{ requestId: 41, success: true },
		{ requestId: 42, success: true },
	],
	totalSuccess: 2,
	totalFailed: 0,
	totalUnknown: 0,
};
const mixed = {
	results: [
		{ requestId: 41, success: true },
		{ requestId: 42, success: false, outcome: "unknown" },
	],
	totalSuccess: 1,
	totalFailed: 0,
	totalUnknown: 1,
};
const json = (body: unknown, status = 200) =>
	new Response(JSON.stringify(body), { status, headers: { "content-type": "application/json" } });
const calls: { path: string; method: string | undefined; body: unknown }[] = [];
function transport(reply: () => Response) {
	vi.stubGlobal("fetch", async (input: RequestInfo | URL, init: RequestInit = {}) => {
		calls.push({ path: String(input), method: init.method, body: JSON.parse(String(init.body)) });
		return reply();
	});
}
afterEach(() => {
	vi.unstubAllGlobals();
	calls.length = 0;
});

describe("Seerr bulk acknowledgement contract", () => {
	// Catches admitting malformed/contradictory evidence as a fulfilled action.
	it.each([
		["null", null],
		["array", []],
		["missing results", { totalSuccess: 2, totalFailed: 0, totalUnknown: 0 }],
		[
			"duplicate ID",
			{
				...success,
				results: [
					{ requestId: 41, success: true },
					{ requestId: 41, success: true },
				],
			},
		],
		[
			"foreign ID",
			{
				...success,
				results: [
					{ requestId: 41, success: true },
					{ requestId: 99, success: true },
				],
			},
		],
		[
			"missing selected ID",
			{ ...success, results: [{ requestId: 41, success: true }], totalSuccess: 1 },
		],
		[
			"unsafe ID",
			{
				...success,
				results: [
					{ requestId: 41, success: true },
					{ requestId: Number.MAX_SAFE_INTEGER + 1, success: true },
				],
			},
		],
		[
			"nonboolean success",
			{
				...success,
				results: [
					{ requestId: 41, success: true },
					{ requestId: 42, success: "true" },
				],
			},
		],
		[
			"success and unknown",
			{
				...mixed,
				results: [
					{ requestId: 41, success: true },
					{ requestId: 42, success: true, outcome: "unknown" },
				],
			},
		],
		[
			"unrecognized outcome",
			{
				...mixed,
				results: [
					{ requestId: 41, success: true },
					{ requestId: 42, success: false, outcome: "complete" },
				],
			},
		],
		[
			"success and error",
			{
				...success,
				results: [
					{ requestId: 41, success: true, error: privateDetail },
					{ requestId: 42, success: true },
				],
			},
		],
		["negative count", { ...success, totalFailed: -1 }],
		["fraction count", { ...success, totalSuccess: 1.5 }],
		["missing count", { results: success.results, totalSuccess: 2, totalFailed: 0 }],
		["wrong count type", { ...success, totalSuccess: "2" }],
		["contradictory success count", { ...mixed, totalSuccess: 2 }],
		["contradictory failed count", { ...mixed, totalFailed: 1 }],
		["contradictory unknown count", { ...mixed, totalUnknown: 0 }],
	] as const)(
		"rejects %s generically with one POST and no retained diagnostic",
		async (_name, body) => {
			transport(() => json(body));
			const action = bulkSeerrRequestAction("north", "approve", [41, 42]);
			await expect(action).rejects.toBeInstanceOf(InvalidSuccessResponseError);
			await expect(action).rejects.toMatchObject({
				message: "Request acknowledgment could not be verified.",
			});
			expect(calls).toEqual([
				{
					path: "/api/seerr/requests/north/bulk",
					method: "POST",
					body: { action: "approve", requestIds: [41, 42] },
				},
			]);
		},
	);
	it.each([
		[
			"truncated JSON",
			() => new Response(`{"${privateDetail}`, { headers: { "content-type": "application/json" } }),
		],
		["non-JSON", () => new Response(privateDetail, { headers: { "content-type": "text/plain" } })],
		["204", () => new Response(null, { status: 204 })],
		[
			"body read failure",
			() => {
				const response = json(success);
				response.json = async () => {
					throw Error(privateDetail);
				};
				return response;
			},
		],
	] as const)("treats %s as unknown acknowledgement without replay", async (_name, reply) => {
		transport(reply);
		await expect(bulkSeerrRequestAction("north", "delete", [41, 42])).rejects.toBeInstanceOf(
			InvalidSuccessResponseError,
		);
		expect(calls).toHaveLength(1);
	});
	it.each([
		[200, success],
		[207, mixed],
		[
			207,
			{
				results: [
					{ requestId: 41, success: true },
					{ requestId: 42, success: false },
				],
				totalSuccess: 1,
				totalFailed: 1,
				totalUnknown: 0,
			},
		],
	] as const)("accepts coherent HTTP %i evidence", async (status, body) => {
		transport(() => json(body, status));
		expect(await bulkSeerrRequestAction("north", "approve", [41, 42])).toEqual(body);
		expect(calls).toHaveLength(1);
	});
	it("discards provider diagnostics from valid acknowledged data", async () => {
		transport(() =>
			json({
				...mixed,
				diagnostic: privateDetail,
				results: [
					{ requestId: 41, success: true },
					{
						requestId: 42,
						success: false,
						outcome: "unknown",
						error: privateDetail,
						diagnostic: privateDetail,
					},
				],
			}),
		);
		const result = await bulkSeerrRequestAction("north", "approve", [41, 42]);
		expect(result).toEqual(mixed);
		expect(JSON.stringify(result)).not.toContain(privateDetail);
	});
	it.each([400, 409, 502])("retains definite HTTP %i error semantics", async (status) => {
		transport(() => json({ message: "Synthetic refusal" }, status));
		const action = bulkSeerrRequestAction("north", "approve", [41, 42]);
		await expect(action).rejects.toBeInstanceOf(ApiError);
		await expect(action).rejects.toMatchObject({ status });
		expect(calls).toHaveLength(1);
	});
});
