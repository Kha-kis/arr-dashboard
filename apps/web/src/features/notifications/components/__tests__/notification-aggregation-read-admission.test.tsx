import type { AggregationConfigResponse } from "@arr/shared";
import { QueryClient, QueryClientProvider } from "@tanstack/react-query";
import { act, cleanup, fireEvent, render, screen, waitFor } from "@testing-library/react";
import { Component, type ReactNode } from "react";
import { afterEach, describe, expect, it, vi } from "vitest";
import { IncognitoProvider } from "../../../../contexts/IncognitoContext";
import { notificationsApi } from "../../../../lib/api-client/notifications";
import { notificationKeys } from "../../../../lib/query-keys";
import { ColorThemeProvider } from "../../../../providers/color-theme-provider";
import { AggregationConfig } from "../aggregation-config";

const path = "/api/notifications/aggregation";
const privateDetail = "synthetic-private-aggregation-read-detail";
// Complete, hand-derived public rows include supported enum keys outside the
// editor's aggregatable subset. Legacy integers are read metadata, not inputs
// to the route's creation-range policy.
const baseline: AggregationConfigResponse[] = [
	{ eventType: "HUNT_CONTENT_FOUND", windowSeconds: 300, maxBatchSize: 1, enabled: true },
	{ eventType: "LOGIN_FAILED", windowSeconds: 60, maxBatchSize: 2, enabled: false },
	{ eventType: "VALIDATION_HEALTH_DEGRADED", windowSeconds: 17, maxBatchSize: 0, enabled: true },
	{ eventType: "SYSTEM_STARTUP", windowSeconds: 0, maxBatchSize: 0, enabled: false },
];
const refreshed: AggregationConfigResponse[] = [
	{ eventType: "HUNT_CONTENT_FOUND", windowSeconds: 120, maxBatchSize: 8, enabled: true },
	{ eventType: "LOGIN_FAILED", windowSeconds: 60, maxBatchSize: 2, enabled: true },
];
const invalidRefresh = [
	{ eventType: "HUNT_CONTENT_FOUND", windowSeconds: 120, maxBatchSize: 8, enabled: true },
	{ eventType: "LOGIN_FAILED", enabled: false, privateDiagnostic: privateDetail },
];
const renderErrors: string[] = [];
const violations: string[] = [];
const clients: QueryClient[] = [];

// Observes the actual editor's render errors; never substitutes the component.
// A malformed response must be rejected before it can reach this boundary.
class ReadBoundary extends Component<{ children: ReactNode }, { failed: boolean }> {
	override state = { failed: false };
	static getDerivedStateFromError() {
		return { failed: true };
	}
	override componentDidCatch(error: Error) {
		renderErrors.push(error.message);
	}
	override render() {
		return this.state.failed ? (
			<p role="alert">Synthetic renderer boundary caught invalid settings.</p>
		) : (
			this.props.children
		);
	}
}

function json(value: unknown, status = 200) {
	return new Response(JSON.stringify(value), {
		status,
		headers: { "Content-Type": "application/json" },
	});
}

function fixture(
	reply: () => Response | Promise<Response>,
	options: { seeded?: boolean; mounted?: boolean } = {},
) {
	const requests: Array<{ path: string; method: string }> = [];
	let currentReply = reply;
	vi.stubGlobal("fetch", async (input: RequestInfo | URL, init: RequestInit = {}) => {
		const request = { path: String(input), method: init.method ?? "GET" };
		requests.push(request);
		if (request.path !== path || request.method !== "GET") {
			violations.push(`${request.method} ${request.path}`);
			throw new Error("Out-of-scope synthetic request");
		}
		return currentReply();
	});
	const client = new QueryClient({
		defaultOptions: {
			queries: {
				refetchOnWindowFocus: false,
				staleTime: 30_000,
				gcTime: 300_000,
				retry: 1,
				// Match permitted production GET retry count; avoid its timing cost.
				retryDelay: 0,
				structuralSharing: true,
			},
		},
	});
	clients.push(client);
	if (options.seeded) {
		client.setQueryData(notificationKeys.aggregation, baseline, { updatedAt: Date.now() - 1000 });
	}
	const prior = client.getQueryData(notificationKeys.aggregation);
	const priorUpdatedAt = client.getQueryState(notificationKeys.aggregation)?.dataUpdatedAt;
	if (options.mounted !== false) {
		render(
			<QueryClientProvider client={client}>
				<ColorThemeProvider>
					<IncognitoProvider>
						<ReadBoundary>
							<AggregationConfig />
						</ReadBoundary>
					</IncognitoProvider>
				</ColorThemeProvider>
			</QueryClientProvider>,
		);
	}
	return {
		client,
		requests,
		prior,
		priorUpdatedAt,
		replaceReply(next: () => Response | Promise<Response>) {
			currentReply = next;
		},
	};
}

async function settled(client: QueryClient) {
	await waitFor(() => {
		const state = client.getQueryState(notificationKeys.aggregation);
		expect(state).toBeDefined();
		expect(state?.fetchStatus).toBe("idle");
		expect(["error", "success"]).toContain(state?.status);
	});
	await act(async () => new Promise((resolve) => setTimeout(resolve, 0)));
}
function cached(client: QueryClient) {
	return client.getQueryData(notificationKeys.aggregation);
}
function windowInput() {
	return screen.getByRole("combobox", { name: "Hunt: Content Found aggregation window" });
}
function expectUnavailable(client: QueryClient) {
	expect.soft(renderErrors).toEqual([]);
	expect
		.soft(screen.queryByText("Synthetic renderer boundary caught invalid settings."))
		.not.toBeInTheDocument();
	expect.soft(client.getQueryState(notificationKeys.aggregation)?.status).toBe("error");
	expect.soft(cached(client)).toBeUndefined();
	expect
		.soft(screen.queryByRole("status", { name: "Loading aggregation settings" }))
		.not.toBeInTheDocument();
	expect.soft(document.body).toHaveTextContent(/couldn't load event aggregation settings/i);
	expect.soft(document.body).toHaveTextContent(/saved settings.*not.*verified/i);
	expect
		.soft(screen.queryByRole("button", { name: "Retry aggregation settings" }))
		.toBeInTheDocument();
	expect
		.soft(screen.queryByRole("button", { name: "Aggregate Hunt: Content Found" }))
		.not.toBeInTheDocument();
	expect.soft(document.body).not.toHaveTextContent(privateDetail);
}
function expectPublicReadError(error: unknown) {
	expect.soft(error).toBeInstanceOf(Error);
	if (error instanceof Error) {
		expect.soft(error.message).not.toContain(privateDetail);
		expect.soft(error.cause).toBeUndefined();
		expect.soft(error).not.toHaveProperty("payload");
		expect.soft(error).not.toHaveProperty("response");
		expect.soft(JSON.stringify(error)).not.toContain(privateDetail);
	}
}
function expectReadsOnly(requests: Array<{ path: string; method: string }>, count: number) {
	expect.soft(requests).toHaveLength(count);
	for (const request of requests) expect(request).toEqual({ path, method: "GET" });
}

afterEach(() => {
	cleanup();
	for (const client of clients.splice(0)) client.clear();
	vi.unstubAllGlobals();
	localStorage.clear();
	renderErrors.splice(0);
	expect(violations.splice(0)).toEqual([]);
});

describe("Ordinary aggregation GET: real client, hook, cache and mounted admission", () => {
	it("control: complete known rows preserve order, explicit disables and integer legacy values", async () => {
		const { client, requests } = fixture(() => json(baseline));
		await settled(client);
		expect(cached(client)).toEqual([
			{ eventType: "HUNT_CONTENT_FOUND", windowSeconds: 300, maxBatchSize: 1, enabled: true },
			{ eventType: "LOGIN_FAILED", windowSeconds: 60, maxBatchSize: 2, enabled: false },
			{
				eventType: "VALIDATION_HEALTH_DEGRADED",
				windowSeconds: 17,
				maxBatchSize: 0,
				enabled: true,
			},
			{ eventType: "SYSTEM_STARTUP", windowSeconds: 0, maxBatchSize: 0, enabled: false },
		]);
		expect(windowInput()).toHaveValue("300");
		expect(
			screen.getByRole("spinbutton", { name: "Hunt: Content Found maximum batch size" }),
		).toHaveValue(1);
		expect(
			screen.getByRole("button", { name: "Aggregate Security: Login Failed" }),
		).toHaveAttribute("aria-pressed", "false");
		expect(screen.queryByRole("button", { name: "Save Changes" })).not.toBeInTheDocument();
		expectReadsOnly(requests, 1);
		expect(renderErrors).toEqual([]);
	});

	it("control: empty array is a verified empty list with usable disabled defaults", async () => {
		const { client, requests } = fixture(() => json([]));
		await settled(client);
		expect(client.getQueryState(notificationKeys.aggregation)?.status).toBe("success");
		expect(cached(client)).toEqual([]);
		expect(screen.getByRole("button", { name: "Aggregate Hunt: Content Found" })).toHaveAttribute(
			"aria-pressed",
			"false",
		);
		expect(
			screen.queryByRole("button", { name: "Retry aggregation settings" }),
		).not.toBeInTheDocument();
		expectReadsOnly(requests, 1);
		expect(renderErrors).toEqual([]);
	});

	it.each([
		["null body", null],
		["nonarray object", { rows: baseline, privateDiagnostic: privateDetail }],
		["null row", [null]],
		["incomplete known row", [{ eventType: "HUNT_CONTENT_FOUND", enabled: false }]],
		["duplicate event key", [baseline[0], baseline[0]]],
		[
			"string enabled",
			[{ eventType: "HUNT_CONTENT_FOUND", windowSeconds: 300, maxBatchSize: 10, enabled: "false" }],
		],
		[
			"unknown event key",
			[
				{
					eventType: "SYNTHETIC_UNKNOWN_EVENT",
					windowSeconds: 300,
					maxBatchSize: 10,
					enabled: false,
				},
			],
		],
		[
			"fractional numeric field",
			[{ eventType: "HUNT_CONTENT_FOUND", windowSeconds: 60.5, maxBatchSize: 10, enabled: true }],
		],
	] as const)(
		"rejects initial %s before publication or rendering verified defaults",
		async (_name, body) => {
			const { client, requests } = fixture(() => json(body));
			await settled(client);
			expectUnavailable(client);
			expectPublicReadError(client.getQueryState(notificationKeys.aggregation)?.error);
			expectReadsOnly(requests, 2);
		},
	);

	it("rejects a partly valid refresh atomically, retaining cache identity, timestamp and exact draft", async () => {
		const { client, requests, prior, priorUpdatedAt } = fixture(() => json(invalidRefresh), {
			seeded: true,
		});
		fireEvent.change(windowInput(), { target: { value: "600" } });
		await act(async () => {
			await client.invalidateQueries({ queryKey: notificationKeys.aggregation });
		});
		await settled(client);
		expect.soft(cached(client)).toBe(prior);
		expect.soft(cached(client)).toEqual(baseline);
		expect
			.soft(client.getQueryState(notificationKeys.aggregation)?.dataUpdatedAt)
			.toBe(priorUpdatedAt);
		expect.soft(client.getQueryState(notificationKeys.aggregation)?.status).toBe("error");
		expect(windowInput()).toHaveValue("600");
		expect
			.soft(document.body)
			.toHaveTextContent(/last-known aggregation settings and your edits; refresh failed/i);
		expect
			.soft(screen.queryByRole("button", { name: "Retry aggregation settings" }))
			.toBeInTheDocument();
		expectPublicReadError(client.getQueryState(notificationKeys.aggregation)?.error);
		expectReadsOnly(requests, 2);
		expect(renderErrors).toEqual([]);
	});

	it("explicit retry recovers an initially unverified read through GET only", async () => {
		const { client, requests, replaceReply } = fixture(() =>
			json([{ eventType: "HUNT_CONTENT_FOUND", enabled: false }]),
		);
		await settled(client);
		replaceReply(() => json(baseline));
		const retry = screen.queryByRole("button", { name: "Retry aggregation settings" });
		expect.soft(retry).toBeInTheDocument();
		if (!retry) return;
		fireEvent.click(retry);
		await settled(client);
		expect(windowInput()).toHaveValue("300");
		expect(cached(client)).toEqual(baseline);
		expect(
			screen.queryByRole("button", { name: "Retry aggregation settings" }),
		).not.toBeInTheDocument();
		expectReadsOnly(requests, 3);
		expect(renderErrors).toEqual([]);
	});

	it("explicit retry after invalid refresh preserves the draft while adopting untouched current rows", async () => {
		const { client, requests, replaceReply } = fixture(() => json(invalidRefresh), {
			seeded: true,
		});
		fireEvent.change(windowInput(), { target: { value: "600" } });
		await act(async () => {
			await client.invalidateQueries({ queryKey: notificationKeys.aggregation });
		});
		await settled(client);
		replaceReply(() => json(refreshed));
		const retry = screen.queryByRole("button", { name: "Retry aggregation settings" });
		expect.soft(retry).toBeInTheDocument();
		if (!retry) return;
		fireEvent.click(retry);
		await settled(client);
		expect(windowInput()).toHaveValue("600");
		expect(
			screen.getByRole("combobox", { name: "Security: Login Failed aggregation window" }),
		).toHaveValue("60");
		expect(screen.getByRole("button", { name: "Save Changes" })).toBeEnabled();
		expect(cached(client)).toEqual(refreshed);
		expect(screen.queryByText(/last-known.*refresh failed/i)).not.toBeInTheDocument();
		expectReadsOnly(requests, 3);
	});

	it("ordinary successful GET publishes only public DTO fields into query cache", async () => {
		const { client, requests } = fixture(() =>
			json([
				{
					eventType: "HUNT_CONTENT_FOUND",
					windowSeconds: 300,
					maxBatchSize: 1,
					enabled: true,
					privateDiagnostic: privateDetail,
				},
			]),
		);
		await settled(client);
		expect(cached(client)).toEqual([
			{ eventType: "HUNT_CONTENT_FOUND", windowSeconds: 300, maxBatchSize: 1, enabled: true },
		]);
		expect(document.body).not.toHaveTextContent(privateDetail);
		expectReadsOnly(requests, 1);
	});

	it("real client returns isolated public array and row projections without private extras", async () => {
		let decoded: unknown;
		const { requests } = fixture(
			() => {
				const response = json([
					{
						eventType: "HUNT_CONTENT_FOUND",
						windowSeconds: 300,
						maxBatchSize: 1,
						enabled: true,
						privateDiagnostic: privateDetail,
					},
				]);
				const decode = response.json.bind(response);
				response.json = async () => {
					decoded = await decode();
					return decoded;
				};
				return response;
			},
			{ mounted: false },
		);
		const result = await notificationsApi.getAggregationConfigs();
		expect
			.soft(result)
			.toEqual([
				{ eventType: "HUNT_CONTENT_FOUND", windowSeconds: 300, maxBatchSize: 1, enabled: true },
			]);
		expect.soft(result).not.toBe(decoded);
		if (Array.isArray(decoded)) expect.soft(result[0]).not.toBe(decoded[0]);
		expectReadsOnly(requests, 1);
	});

	it.each([
		["HTTP failure", () => json({ message: privateDetail, privateDiagnostic: privateDetail }, 503)],
		["network failure", () => Promise.reject(new Error(privateDetail))],
	] as const)(
		"keeps %s diagnostics out of the public read error while allowing GET retry",
		async (_name, reply) => {
			const { client, requests } = fixture(reply);
			await settled(client);
			expectUnavailable(client);
			expectPublicReadError(client.getQueryState(notificationKeys.aggregation)?.error);
			expectReadsOnly(requests, 2);
		},
	);
});
