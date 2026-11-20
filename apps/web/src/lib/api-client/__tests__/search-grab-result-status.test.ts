import type { SearchGrabResultStatusRequest } from "@arr/shared";
import { afterEach, describe, expect, it, vi } from "vitest";
import { UnauthorizedError } from "../base";

const entry = {
	instanceId: "synthetic-instance",
	selector: `sg1.${"A".repeat(16)}.${"A".repeat(23)}`,
};
const payload = { results: [entry, entry, entry] };
const status = {
	attemptId: "770ecb14-0000-4000-8000-000000000002",
	intentId: "770ecb14-0000-4000-8000-000000000001",
	state: "uncertain",
	requestedAt: "2026-10-10T01:00:00.000Z",
	dispatchedAt: "2026-10-10T01:00:01.000Z",
	completedAt: "2026-10-10T01:00:02.000Z",
	outcomeCategory: "transport-unconfirmed",
	nextAction: "inspect-before-confirmed-retry",
};
const response = {
	results: [
		{ resultIndex: 0, availability: "recorded", status },
		{ resultIndex: 1, availability: "not-recorded", status: null },
		{ resultIndex: 2, availability: "unavailable", status: null },
	],
};
afterEach(() => vi.unstubAllGlobals());
describe("actual web result-status client", () => {
	it("preserves distinct generic outcomes through one authenticated body-only read request", async () => {
		const { fetchSearchGrabResultStatuses } = await import("../search");
		const calls: Array<{ url: string; options: RequestInit }> = [];
		vi.stubGlobal("fetch", async (url: string, options: RequestInit) => {
			calls.push({ url, options });
			return new Response(JSON.stringify(response), {
				status: 200,
				headers: { "content-type": "application/json" },
			});
		});
		expect(await fetchSearchGrabResultStatuses(payload)).toEqual(response);
		expect(calls).toHaveLength(1);
		expect(calls[0]!.url).toBe("/api/search/grab/results/status");
		expect(calls[0]!.url).not.toContain(entry.selector);
		expect(calls[0]!.options).toMatchObject({ method: "POST", credentials: "include" });
		expect(JSON.parse(String(calls[0]!.options.body))).toEqual(payload);
	});
	it.each([
		{ results: [] },
		{ results: Array.from({ length: 51 }, () => entry) },
		{
			results: [
				{ instanceId: entry.instanceId, guid: "SYNTHETIC_PRIVATE_DIAGNOSTIC", indexerId: 7 },
			],
		},
		{ results: [{ ...entry, selector: "bad" }] },
		{ results: [{ ...entry, guid: "SYNTHETIC_PRIVATE_DIAGNOSTIC" }] },
		{ results: [{ ...entry, instanceId: "" }] },
		{ results: [{ ...entry, selector: "x".repeat(16_385) }] },
	])("refuses invalid or unbounded input before any fetch %#", async (value) => {
		const { fetchSearchGrabResultStatuses } = await import("../search");
		let calls = 0;
		vi.stubGlobal("fetch", async () => {
			calls++;
			throw new Error("SYNTHETIC_PRIVATE_DIAGNOSTIC");
		});
		await expect(
			fetchSearchGrabResultStatuses(value as SearchGrabResultStatusRequest),
		).rejects.toThrow(/unavailable/i);
		expect(calls).toBe(0);
	});
	it.each([400, 404, 502, 503, 201, 202, 204])(
		"HTTP %i cannot become recorded or absent evidence and is not retried",
		async (code) => {
			const { fetchSearchGrabResultStatuses } = await import("../search");
			let calls = 0;
			vi.stubGlobal("fetch", async () => {
				calls++;
				return new Response(
					code === 204
						? null
						: JSON.stringify(code >= 400 ? { message: "SYNTHETIC_PRIVATE_DIAGNOSTIC" } : response),
					{ status: code, headers: { "content-type": "application/json" } },
				);
			});
			const error = await fetchSearchGrabResultStatuses(payload).then(
				() => null,
				(failure: unknown) => failure,
			);
			expect(error).toBeInstanceOf(Error);
			expect(String(error)).toMatch(/unavailable/i);
			expect(String(error)).not.toContain("SYNTHETIC_PRIVATE_DIAGNOSTIC");
			expect(calls).toBe(1);
		},
	);
	it("network loss remains unavailable without retry, mutation fallback or private diagnostics", async () => {
		const { fetchSearchGrabResultStatuses } = await import("../search");
		const paths: string[] = [];
		vi.stubGlobal("fetch", async (url: string) => {
			paths.push(url);
			throw new Error("SYNTHETIC_PRIVATE_DIAGNOSTIC");
		});
		const error = await fetchSearchGrabResultStatuses(payload).then(
			() => null,
			(failure: unknown) => failure,
		);
		expect(error).toBeInstanceOf(Error);
		expect(String(error)).toMatch(/unavailable/i);
		expect(String(error)).not.toContain("SYNTHETIC_PRIVATE_DIAGNOSTIC");
		expect(paths).toEqual(["/api/search/grab/results/status"]);
	});
	it("preserves session-expiry recovery without inventing a submission outcome", async () => {
		const { fetchSearchGrabResultStatuses } = await import("../search");
		let calls = 0;
		vi.stubGlobal("fetch", async () => {
			calls++;
			return new Response(null, { status: 401 });
		});
		await expect(fetchSearchGrabResultStatuses(payload)).rejects.toBeInstanceOf(UnauthorizedError);
		expect(calls).toBe(1);
	});
	it("malformed JSON success is unavailable rather than empty history", async () => {
		const { fetchSearchGrabResultStatuses } = await import("../search");
		vi.stubGlobal(
			"fetch",
			async () =>
				new Response("SYNTHETIC_PRIVATE_DIAGNOSTIC", {
					status: 200,
					headers: { "content-type": "application/json" },
				}),
		);
		await expect(fetchSearchGrabResultStatuses(payload)).rejects.toThrow(/unavailable/i);
	});
	it.each([
		{ results: response.results.slice(0, 2) },
		{
			results: [
				...response.results,
				{ resultIndex: 3, availability: "not-recorded", status: null },
			],
		},
		{
			results: [
				{ ...response.results[0], resultIndex: 1 },
				response.results[1],
				response.results[2],
			],
		},
		{
			results: [
				{ ...response.results[0], selector: "SYNTHETIC_PRIVATE_DIAGNOSTIC" },
				response.results[1],
				response.results[2],
			],
		},
		{
			results: [{ ...response.results[0], status: null }, response.results[1], response.results[2]],
		},
		{
			results: [
				response.results[0],
				{ resultIndex: 1, availability: "not-delivered", status: null },
				response.results[2],
			],
		},
	])("refuses incomplete, mismatched or unsafe successful evidence %#", async (value) => {
		const { fetchSearchGrabResultStatuses } = await import("../search");
		let calls = 0;
		vi.stubGlobal("fetch", async () => {
			calls++;
			return new Response(JSON.stringify(value), {
				status: 200,
				headers: { "content-type": "application/json" },
			});
		});
		const error = await fetchSearchGrabResultStatuses(payload).then(
			() => null,
			(failure: unknown) => failure,
		);
		expect(error).toBeInstanceOf(Error);
		expect(String(error)).toMatch(/unavailable/i);
		expect(String(error)).not.toContain("SYNTHETIC_PRIVATE_DIAGNOSTIC");
		expect(calls).toBe(1);
	});
});
