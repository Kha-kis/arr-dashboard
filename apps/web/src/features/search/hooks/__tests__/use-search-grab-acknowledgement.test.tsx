import type { SearchResult } from "@arr/shared";
import { QueryClient, QueryClientProvider } from "@tanstack/react-query";
import { act, cleanup, renderHook } from "@testing-library/react";
import type { ReactNode } from "react";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { IncognitoProvider } from "../../../../contexts/IncognitoContext";
import { QUEUE_QUERY_KEY } from "../../../../lib/query-keys";
import { useSearchGrabRecovery } from "../use-search-grab-recovery";
import { useSearchState } from "../use-search-state";

const result: SearchResult = {
	id: "synthetic-grab-guid",
	guid: "synthetic-grab-guid",
	title: "Synthetic release",
	indexer: "Synthetic indexer",
	indexerId: 7,
	protocol: "torrent",
	instanceId: "owned-instance",
	instanceName: "Synthetic connection",
	grabSelector: `sg1.${"A".repeat(16)}.${"A".repeat(23)}`,
};
const privateDiagnostic = "SYNTHETIC_PRIVATE_GRAB_DIAGNOSTIC";
let client: QueryClient;
let intentAcknowledged = false;

beforeEach(() => {
	window.localStorage.clear();
	// RootProviders does not override mutation retry; retain its actual default.
	client = new QueryClient();
	intentAcknowledged = false;
});
afterEach(() => {
	cleanup();
	client.clear();
	vi.restoreAllMocks();
	vi.unstubAllGlobals();
});

function mount(rows: SearchResult[] = [result]) {
	const wrapper = ({ children }: { children: ReactNode }) => (
		<QueryClientProvider client={client}>
			<IncognitoProvider>{children}</IncognitoProvider>
		</QueryClientProvider>
	);
	return renderHook(
		() => {
			const state = useSearchState();
			const actions = useSearchGrabRecovery(rows, state.actions);
			return { state, ...actions };
		},
		{ wrapper },
	);
}

function interceptReads(grab: (url: string, options: RequestInit) => Promise<Response>) {
	vi.stubGlobal("fetch", async (url: string, options: RequestInit) => {
		if (url === "/api/search/grab/results/status") {
			const body = JSON.parse(String(options.body));
			return new Response(
				JSON.stringify({
					results: body.results.map((_: unknown, resultIndex: number) => ({
						resultIndex,
						availability: "not-recorded",
						status: null,
					})),
				}),
				{ status: 200, headers: { "content-type": "application/json" } },
			);
		}
		if (url.includes("/api/search/grab/intents/")) {
			if (!intentAcknowledged) return new Response(null, { status: 404 });
			return new Response(
				JSON.stringify({
					attemptId: "11111111-1111-4111-8111-111111111111",
					intentId: url.split("/").at(-1),
					state: "acknowledged",
					requestedAt: "2026-10-10T00:00:00.000Z",
					dispatchedAt: "2026-10-10T00:00:01.000Z",
					completedAt: "2026-10-10T00:00:02.000Z",
					outcomeCategory: null,
					nextAction: "none",
				}),
				{ status: 200, headers: { "content-type": "application/json" } },
			);
		}
		return grab(url, options);
	});
}

function intercept(response: Response) {
	const fetch = vi.fn(async (url: string, options: RequestInit) => {
		expect(url).toBe("/api/search/grab");
		expect(options.method).toBe("POST");
		expect(options.credentials).toBe("include");
		const payload = JSON.parse(options.body as string);
		expect(payload).toMatchObject({
			instanceId: "owned-instance",
			selector: result.grabSelector,
		});
		expect(Object.keys(payload).sort()).toEqual(["instanceId", "intentId", "selector"]);
		expect(payload.intentId).toMatch(
			/^[a-f0-9]{8}-[a-f0-9]{4}-4[a-f0-9]{3}-[89ab][a-f0-9]{3}-[a-f0-9]{12}$/,
		);
		return response;
	});
	interceptReads(fetch);
	return fetch;
}

describe("real Search action, mutation and API acknowledgement admission", () => {
	it("observes the same known intent with no repeated POST after a lost reply", async () => {
		const payloads: Array<Record<string, unknown>> = [];
		interceptReads(async (_url: string, options: RequestInit) => {
			payloads.push(JSON.parse(String(options.body)));
			throw new Error("Synthetic reply loss");
		});
		const hook = mount();
		await act(async () => hook.result.current.handleGrab(result));
		await act(async () => hook.result.current.handleGrab(result));
		expect(payloads).toHaveLength(1);
		expect(payloads[0]).not.toHaveProperty("result");
		expect(payloads[0]?.intentId).toEqual(expect.any(String));
	});
	it("does not automatically replay even when the global mutation default enables retry", async () => {
		client.setDefaultOptions({ mutations: { retry: 2, retryDelay: 1 } });
		const fetch = vi.fn().mockRejectedValue(new Error("Synthetic reply loss"));
		interceptReads(fetch);
		const hook = mount();
		await act(async () => hook.result.current.handleGrab(result));
		expect(fetch).toHaveBeenCalledTimes(1);
		expect(hook.result.current.state.feedback?.type).toBe("error");
	});
	it("keeps a display-only result visible but requests a new search instead of fabricating provenance", async () => {
		const fetch = vi.fn();
		vi.stubGlobal("fetch", fetch);
		const { grabSelector: _selector, ...displayOnly } = result;
		const hook = mount([displayOnly]);
		await act(async () => hook.result.current.handleGrab(displayOnly));
		expect(fetch).not.toHaveBeenCalled();
		expect(hook.result.current.state.feedback?.type).toBe("error");
		expect(hook.result.current.state.feedback?.incognitoMessage).toMatch(/new search/i);
	});
	// Removing precise status admission must not silently turn these replies
	// into queue invalidation or a successful user-facing Grab announcement.
	it.each([
		{
			label: "200 JSON false",
			status: 200,
			body: JSON.stringify({ success: false, message: privateDiagnostic }),
			type: "application/json",
		},
		{
			label: "200 JSON true",
			status: 200,
			body: JSON.stringify({ success: true, message: privateDiagnostic }),
			type: "application/json",
		},
		{
			label: "200 HTML",
			status: 200,
			body: `<html>${privateDiagnostic}</html>`,
			type: "text/html",
		},
		{
			label: "201 JSON",
			status: 201,
			body: JSON.stringify({ guid: privateDiagnostic }),
			type: "application/json",
		},
		{
			label: "202 accepted",
			status: 202,
			body: JSON.stringify({ status: "accepted", message: privateDiagnostic }),
			type: "application/json",
		},
		{ label: "203 non-authoritative", status: 203, body: privateDiagnostic, type: "text/plain" },
		{ label: "205 empty", status: 205, body: null, type: "text/plain" },
		{ label: "206 partial", status: 206, body: privateDiagnostic, type: "text/plain" },
		{ label: "207 multistatus", status: 207, body: privateDiagnostic, type: "text/plain" },
		{ label: "208 reported", status: 208, body: privateDiagnostic, type: "text/plain" },
		{ label: "226 transformed", status: 226, body: privateDiagnostic, type: "text/plain" },
	])(
		"does not announce success or consume an unexpected $label acknowledgement",
		async ({ status, body, type }) => {
			const response = new Response(body, { status, headers: { "content-type": type } });
			const json = vi.spyOn(response, "json");
			const text = vi.spyOn(response, "text");
			const fetch = intercept(response);
			const invalidate = vi.spyOn(client, "invalidateQueries");
			const hook = mount();
			await act(async () => hook.result.current.handleGrab(result));
			expect(hook.result.current.state.feedback).toMatchObject({
				type: "error",
				incognitoMessage:
					"Could not confirm the grab result. Check Prowlarr and the download client before retrying.",
			});
			expect(JSON.stringify(hook.result.current.state.feedback)).not.toContain(privateDiagnostic);
			expect(hook.result.current.state.grabbingKey).toBeNull();
			expect(hook.result.current.state.feedback?.message).toMatch(
				/(unknown|could not confirm).*check Prowlarr.*before retrying/i,
			);
			expect(invalidate).not.toHaveBeenCalled();
			expect(fetch).toHaveBeenCalledTimes(1);
			expect(json).not.toHaveBeenCalled();
			expect(text).not.toHaveBeenCalled();
		},
	);

	// Rejecting all statuses would also be a regression: the route's actual
	// empty204 remains confirmed success and invalidates the existing queue key.
	it("announces success and invalidates queue only for the actual empty 204 contract", async () => {
		const response = new Response(null, { status: 204 });
		const json = vi.spyOn(response, "json");
		const text = vi.spyOn(response, "text");
		const fetch = intercept(response);
		const invalidate = vi.spyOn(client, "invalidateQueries");
		const hook = mount();
		await act(async () => hook.result.current.handleGrab(result));
		expect(hook.result.current.state.feedback).toMatchObject({
			type: "success",
			message: 'Sent "Synthetic release" to the download client.',
		});
		expect(hook.result.current.state.grabbingKey).toBeNull();
		expect(invalidate).toHaveBeenCalledExactlyOnceWith({ queryKey: QUEUE_QUERY_KEY });
		expect(fetch).toHaveBeenCalledTimes(1);
		expect(json).not.toHaveBeenCalled();
		expect(text).not.toHaveBeenCalled();
	});

	// A precise success contract must not swallow real HTTP failures or replay
	// the action. Actual central API error parsing and the action catch are real.
	it.each([400, 401, 404, 409, 502])(
		"keeps HTTP %i out of successful state without redispatch",
		async (status) => {
			const fetch = intercept(
				new Response(JSON.stringify({ message: "Synthetic bounded denial" }), {
					status,
					headers: { "content-type": "application/json" },
				}),
			);
			const invalidate = vi.spyOn(client, "invalidateQueries");
			const hook = mount();
			await act(async () => hook.result.current.handleGrab(result));
			expect(hook.result.current.state.feedback?.type).toBe("error");
			expect(hook.result.current.state.grabbingKey).toBeNull();
			expect(invalidate).not.toHaveBeenCalled();
			expect(fetch).toHaveBeenCalledTimes(1);
		},
	);

	it("does not announce success or automatically replay after transport failure", async () => {
		const fetch = vi.fn().mockRejectedValue(new Error("Synthetic transport failure"));
		interceptReads(fetch);
		const invalidate = vi.spyOn(client, "invalidateQueries");
		const hook = mount();
		await act(async () => hook.result.current.handleGrab(result));
		expect(hook.result.current.state.feedback?.type).toBe("error");
		expect(hook.result.current.state.feedback?.message).toMatch(
			/(unknown|could not confirm).*check Prowlarr.*before retrying/i,
		);
		expect(invalidate).not.toHaveBeenCalled();
		expect(fetch).toHaveBeenCalledTimes(1);
	});

	// Catches an ambiguous API failure becoming a raw error (or being mistaken
	// for a configured-client rejection) in either feedback mode.
	it.each([408, 429, 500, 502, 503, 504])(
		"keeps HTTP %i uncertainty actionable in normal and incognito feedback",
		async (status) => {
			const fetch = intercept(
				new Response(
					JSON.stringify({ message: `Download client isn't configured ${privateDiagnostic}` }),
					{ status, headers: { "content-type": "application/json" } },
				),
			);
			const invalidate = vi.spyOn(client, "invalidateQueries");
			const hook = mount();
			await act(async () => hook.result.current.handleGrab(result));
			expect(hook.result.current.state.feedback?.type).toBe("error");
			for (const field of ["message", "incognitoMessage"] as const)
				expect(hook.result.current.state.feedback?.[field]).toMatch(
					/(unknown|could not confirm).*check Prowlarr.*before retrying/i,
				);
			expect(JSON.stringify(hook.result.current.state.feedback)).not.toContain(privateDiagnostic);
			expect(hook.result.current.state.grabbingKey).toBeNull();
			expect(invalidate).not.toHaveBeenCalled();
			expect(fetch).toHaveBeenCalledTimes(1);
		},
	);

	it("retains actionable configured-client rejection rather than calling it uncertain", async () => {
		const fetch = intercept(
			new Response(JSON.stringify({ message: "Download client isn't configured" }), {
				status: 400,
				headers: { "content-type": "application/json" },
			}),
		);
		const invalidate = vi.spyOn(client, "invalidateQueries");
		const hook = mount();
		await act(async () => hook.result.current.handleGrab(result));
		expect(hook.result.current.state.feedback).toMatchObject({
			type: "error",
			message: "Configure a torrent download client in Prowlarr before grabbing releases.",
			incognitoMessage: "Configure a torrent download client in Prowlarr before grabbing releases.",
		});
		expect(invalidate).not.toHaveBeenCalled();
		expect(fetch).toHaveBeenCalledTimes(1);
	});

	// The second explicit action reads the known intent; it never repeats the POST.
	it("recovers a durable acknowledgement by observation without replaying the first call", async () => {
		const fetch = intercept(new Response(privateDiagnostic, { status: 200 }));
		const invalidate = vi.spyOn(client, "invalidateQueries");
		const hook = mount();
		await act(async () => hook.result.current.handleGrab(result));
		expect(hook.result.current.state.feedback?.type).toBe("error");
		expect(fetch).toHaveBeenCalledTimes(1);
		expect(invalidate).not.toHaveBeenCalled();
		intentAcknowledged = true;
		await act(async () => hook.result.current.handleGrab(result));
		expect(hook.result.current.state.feedback?.type).toBe("success");
		expect(fetch).toHaveBeenCalledTimes(1);
		expect(invalidate).toHaveBeenCalledExactlyOnceWith({ queryKey: QUEUE_QUERY_KEY });
	});
});
