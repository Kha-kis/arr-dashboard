import { QueryClient, QueryClientProvider } from "@tanstack/react-query";
import { act, cleanup, fireEvent, render, screen, waitFor, within } from "@testing-library/react";
import { Component, type ReactNode } from "react";
import { afterEach, describe, expect, it, vi } from "vitest";
import { IncognitoProvider } from "../../../../contexts/IncognitoContext";
import { notificationsApi } from "../../../../lib/api-client/notifications";
import { notificationKeys } from "../../../../lib/query-keys";
import { ColorThemeProvider } from "../../../../providers/color-theme-provider";
import { NotificationStatistics } from "../notification-statistics";

const path = "/api/notifications/statistics?days=30";
const key = notificationKeys.statistics(30);
const privateDetail = "synthetic-private-statistics-admission-detail";
// Complete literal wire truth. Historic group tags and counts need not reconcile
// across independently captured breakdowns; the DST window is not days*24 hours.
const baseline = {
	period: { days: 30, since: "2026-03-01T12:00:00Z", until: "2026-03-31T11:00:00Z" },
	totals: { sent: 8, failed: 2, deadLetter: 1, total: 15, successRate: 53.33 },
	perChannel: [
		{
			channelId: "synthetic-stat-channel",
			channelType: "LEGACY_MAIL",
			sent: 8,
			failed: 1,
			successRate: 88.89,
		},
	],
	perEventType: [
		{ eventType: "LEGACY_NOTICE", count: 4 },
		{ eventType: "HUNT_COMPLETED", count: 6 },
	],
	dailyTrend: [
		{ date: "2026-03-08", sent: 3, failed: 1 },
		{ date: "2026-03-09", sent: 2, failed: 4 },
	],
};
const zero = {
	period: { days: 30, since: "2026-09-06T12:00:00Z", until: "2026-10-06T12:00:00Z" },
	totals: { sent: 0, failed: 0, deadLetter: 0, total: 0, successRate: 0 },
	perChannel: [],
	perEventType: [],
	dailyTrend: [],
};
const legacyZero = {
	period: { days: 30, since: "2026-09-06T12:00:00Z", until: "2026-10-06T12:00:00Z" },
	totals: { sent: 0, failed: 0, deadLetter: 0, total: 0, successRate: 100 },
	perChannel: [
		{
			channelId: "synthetic-legacy-zero",
			channelType: "LEGACY_MAIL",
			sent: 0,
			failed: 0,
			successRate: 100,
		},
	],
	perEventType: [],
	dailyTrend: [],
};
const recovered = {
	period: { days: 30, since: "2026-03-01T12:00:00Z", until: "2026-03-31T11:00:00Z" },
	totals: { sent: 12, failed: 2, deadLetter: 1, total: 15, successRate: 80 },
	perChannel: [
		{
			channelId: "synthetic-stat-channel",
			channelType: "LEGACY_MAIL",
			sent: 12,
			failed: 1,
			successRate: 92.31,
		},
	],
	perEventType: [
		{ eventType: "LEGACY_NOTICE", count: 4 },
		{ eventType: "HUNT_COMPLETED", count: 10 },
	],
	dailyTrend: [
		{ date: "2026-03-08", sent: 3, failed: 1 },
		{ date: "2026-03-09", sent: 6, failed: 4 },
	],
};
const clients: QueryClient[] = [];
const renderErrors: string[] = [];
const violations: string[] = [];
class StatisticsReadBoundary extends Component<{ children: ReactNode }, { failed: boolean }> {
	override state = { failed: false };
	static getDerivedStateFromError() {
		return { failed: true };
	}
	override componentDidCatch(error: Error) {
		renderErrors.push(error.message);
	}
	override render() {
		return this.state.failed ? (
			<p role="alert">Synthetic Statistics renderer boundary.</p>
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
	reply: (path: string) => Response | Promise<Response>,
	options: { seed?: boolean; mount?: boolean } = {},
) {
	const requests: Array<{ path: string; method: string }> = [];
	let currentReply = reply;
	vi.stubGlobal("fetch", async (input: RequestInfo | URL, init: RequestInit = {}) => {
		const request = { path: String(input), method: init.method ?? "GET" };
		requests.push(request);
		if (
			!/^\/api\/notifications\/statistics\?days=(7|14|30|90)$/.test(request.path) ||
			request.method !== "GET" ||
			init.body !== undefined
		) {
			violations.push(`${request.method} ${request.path}`);
			throw new Error("Out-of-scope synthetic request");
		}
		return currentReply(request.path);
	});
	const client = new QueryClient({
		defaultOptions: {
			queries: {
				refetchOnWindowFocus: false,
				staleTime: 30_000,
				gcTime: 300_000,
				retry: 1,
				retryDelay: 0,
				structuralSharing: true,
			},
		},
	});
	clients.push(client);
	if (options.seed) client.setQueryData(key, baseline, { updatedAt: Date.now() - 1000 });
	if (options.mount !== false)
		render(
			<QueryClientProvider client={client}>
				<ColorThemeProvider>
					<IncognitoProvider>
						<StatisticsReadBoundary>
							<NotificationStatistics />
						</StatisticsReadBoundary>
					</IncognitoProvider>
				</ColorThemeProvider>
			</QueryClientProvider>,
		);
	return {
		client,
		requests,
		replaceReply(next: typeof reply) {
			currentReply = next;
		},
	};
}
async function settled(client: QueryClient, queryKey: readonly unknown[] = key) {
	await waitFor(() => {
		const state = client.getQueryState(queryKey);
		expect(state?.fetchStatus).toBe("idle");
		expect(["success", "error"]).toContain(state?.status);
	});
	await act(async () => new Promise((resolve) => setTimeout(resolve, 0)));
}
function metric(label: string) {
	return (
		screen.queryByText(label, { selector: "p" })?.parentElement?.lastElementChild?.textContent ??
		null
	);
}
function expectUnavailable(client: QueryClient, queryKey: readonly unknown[] = key) {
	expect.soft(renderErrors).toEqual([]);
	expect
		.soft(screen.queryByText("Synthetic Statistics renderer boundary."))
		.not.toBeInTheDocument();
	expect.soft(client.getQueryState(queryKey)?.status).toBe("error");
	expect.soft(client.getQueryData(queryKey)).toBeUndefined();
	expect.soft(document.body).toHaveTextContent(/couldn't load notification statistics/i);
	expect.soft(screen.queryByText("No statistics yet")).not.toBeInTheDocument();
	expect.soft(metric("Total Sent")).toBeNull();
	expect.soft(screen.queryByRole("button", { name: "Try again" })).toBeInTheDocument();
	expect.soft(document.body).not.toHaveTextContent(privateDetail);
}
function expectPublicError(error: unknown) {
	expect.soft(error).toBeInstanceOf(Error);
	if (error instanceof Error) {
		expect.soft(error.message).not.toContain(privateDetail);
		expect.soft(error.cause).toBeUndefined();
		expect.soft(error).not.toHaveProperty("payload");
		expect.soft(error).not.toHaveProperty("response");
		expect.soft(JSON.stringify(error)).not.toContain(privateDetail);
	}
}
function expectReads(requests: Array<{ path: string; method: string }>, count: number) {
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

describe("Notification Statistics ordinary GET admission", () => {
	it("control: historic groups, order, independent counts and captured DST window remain literal", async () => {
		const { client, requests } = fixture(() => json(baseline));
		await settled(client);
		expect(client.getQueryData(key)).toEqual(baseline);
		expect(metric("Total Sent")).toBe("8");
		expect(metric("Failed")).toBe("2");
		expect(metric("Dead Letter")).toBe("1");
		expect(metric("Success Rate")).toBe("Not verified");
		expect(metric("Unclassified")).toBe("Not verified");
		expect(document.body).toHaveTextContent(/classification unverified/i);
		expect(screen.getByText("LEGACY_MAIL")).toBeInTheDocument();
		expect(screen.getByText("LEGACY_NOTICE")).toBeInTheDocument();
		expect(
			within(screen.getByTitle("2026-03-08: 3 sent, 1 failed")).getByText("3/8"),
		).toBeInTheDocument();
		expect(renderErrors).toEqual([]);
		expectReads(requests, 1);
	});
	it("control: complete zero statistics with empty breakdowns is measured as unavailable rate", async () => {
		const { client, requests } = fixture(() => json(zero));
		await settled(client);
		expect(client.getQueryData(key)).toEqual(zero);
		expect(metric("Total Sent")).toBe("0");
		expect(metric("Success Rate")).toBe("Not measured");
		expectReads(requests, 1);
	});
	it("control: legacy total-zero rate100 sentinel stays literal without claiming measured success", async () => {
		const { client, requests } = fixture(() => json(legacyZero));
		await settled(client);
		expect(client.getQueryData(key)).toEqual(legacyZero);
		expect(metric("Success Rate")).toBe("Not measured");
		expect(document.body).toHaveTextContent("0/0 sent (Not measured)");
		expectReads(requests, 1);
	});
	it.each([
		["null envelope", null],
		[
			"missing totals",
			{ period: baseline.period, perChannel: [], perEventType: [], dailyTrend: [] },
		],
		["nonarray daily trend", { ...baseline, dailyTrend: {} }],
		["null channel row", { ...baseline, perChannel: [null] }],
		["string success rate", { ...baseline, totals: { ...baseline.totals, successRate: "53.33" } }],
		[
			"negative event count",
			{ ...baseline, perEventType: [{ eventType: "LEGACY_NOTICE", count: -1 }] },
		],
		["fractional counter", { ...baseline, totals: { ...baseline.totals, sent: 1.5 } }],
		[
			"rate outside finite range",
			{ ...baseline, totals: { ...baseline.totals, successRate: 101 } },
		],
		["invalid UTC date", { ...baseline, dailyTrend: [{ date: "2026-02-30", sent: 3, failed: 1 }] }],
		["incomplete event row", { ...baseline, perEventType: [{ eventType: "LEGACY_NOTICE" }] }],
		[
			"duplicate group identity",
			{ ...baseline, perChannel: [baseline.perChannel[0], baseline.perChannel[0]] },
		],
		[
			"invalid period timestamp",
			{ ...baseline, period: { ...baseline.period, since: "not-a-date" } },
		],
	] as const)("rejects successful %s before cache or renderer admission", async (_name, body) => {
		const { client, requests } = fixture(() => json(body));
		await settled(client);
		expectUnavailable(client);
		expectPublicError(client.getQueryState(key)?.error);
		expectReads(requests, 2);
	});
	it("rejects a wrong echoed days scope after the user selects 7d", async () => {
		const { client, requests } = fixture(() => json(baseline), { seed: true });
		fireEvent.click(screen.getByRole("button", { name: "7d" }));
		const selectedKey = notificationKeys.statistics(7);
		await settled(client, selectedKey);
		expectUnavailable(client, selectedKey);
		expectPublicError(client.getQueryState(selectedKey)?.error);
		expect(client.getQueryData(key)).toEqual(baseline);
		expect.soft(requests).toHaveLength(2);
		for (const request of requests)
			expect(request).toEqual({ path: "/api/notifications/statistics?days=7", method: "GET" });
	});
	it("invalid mixed refresh retains cache object/time and selected period; retry reads current statistics", async () => {
		const { client, requests, replaceReply } = fixture(
			() =>
				json({
					...baseline,
					perChannel: [baseline.perChannel[0], { channelId: "incomplete-refresh" }],
				}),
			{ seed: true },
		);
		const prior = client.getQueryData(key);
		const updatedAt = client.getQueryState(key)?.dataUpdatedAt;
		await act(async () => {
			await client.invalidateQueries({ queryKey: key, exact: true });
		});
		await settled(client);
		expect.soft(client.getQueryData(key)).toBe(prior);
		expect.soft(client.getQueryState(key)?.dataUpdatedAt).toBe(updatedAt);
		expect.soft(document.body).toHaveTextContent(/last-known statistics.*refresh failed/i);
		expect(metric("Total Sent")).toBe("8");
		replaceReply(() => json(recovered));
		const retry = screen.queryByRole("button", { name: "Try again" });
		expect.soft(retry).toBeInTheDocument();
		if (!retry) return;
		fireEvent.click(retry);
		await settled(client);
		expect(client.getQueryData(key)).toEqual(recovered);
		expect(metric("Total Sent")).toBe("12");
		expectReads(requests, 3);
	});
	it("explicit GET-only retry recovers initial malformed statistics without replaying a mutation", async () => {
		const { client, requests, replaceReply } = fixture(() => json(null));
		await settled(client);
		replaceReply(() => json(baseline));
		const retry = screen.queryByRole("button", { name: "Try again" });
		expect.soft(retry).toBeInTheDocument();
		if (!retry) return;
		fireEvent.click(retry);
		await settled(client);
		expect(client.getQueryData(key)).toEqual(baseline);
		expect(metric("Total Sent")).toBe("8");
		expectReads(requests, 3);
	});
	it("successful Statistics reads strip extras at every cache envelope and nested depth", async () => {
		const { client, requests } = fixture(() =>
			json({
				...baseline,
				privateDiagnostic: privateDetail,
				period: { ...baseline.period, privateDiagnostic: privateDetail },
				totals: { ...baseline.totals, privateDiagnostic: privateDetail },
				perChannel: baseline.perChannel.map((row) => ({
					...row,
					privateDiagnostic: privateDetail,
				})),
				perEventType: baseline.perEventType.map((row) => ({
					...row,
					privateDiagnostic: privateDetail,
				})),
				dailyTrend: baseline.dailyTrend.map((row) => ({
					...row,
					privateDiagnostic: privateDetail,
				})),
			}),
		);
		await settled(client);
		expect(client.getQueryData(key)).toEqual(baseline);
		expect(document.body).not.toHaveTextContent(privateDetail);
		expectReads(requests, 1);
	});
	it("real Statistics client returns fresh public copies throughout the nested response", async () => {
		let decoded: unknown;
		const { requests } = fixture(
			() => {
				const response = json({
					...baseline,
					privateDiagnostic: privateDetail,
					period: { ...baseline.period, privateDiagnostic: privateDetail },
					totals: { ...baseline.totals, privateDiagnostic: privateDetail },
					perChannel: baseline.perChannel.map((row) => ({
						...row,
						privateDiagnostic: privateDetail,
					})),
					perEventType: baseline.perEventType.map((row) => ({
						...row,
						privateDiagnostic: privateDetail,
					})),
					dailyTrend: baseline.dailyTrend.map((row) => ({
						...row,
						privateDiagnostic: privateDetail,
					})),
				});
				const decode = response.json.bind(response);
				response.json = async () => {
					decoded = await decode();
					return decoded;
				};
				return response;
			},
			{ mount: false },
		);
		const result = await notificationsApi.getStatistics(30);
		expect.soft(result).toEqual(baseline);
		expect.soft(result).not.toBe(decoded);
		const raw = decoded as typeof baseline;
		expect.soft(result.period).not.toBe(raw.period);
		expect.soft(result.totals).not.toBe(raw.totals);
		expect.soft(result.perChannel).not.toBe(raw.perChannel);
		expect.soft(result.perChannel[0]).not.toBe(raw.perChannel[0]);
		expect.soft(result.perEventType).not.toBe(raw.perEventType);
		expect.soft(result.perEventType[0]).not.toBe(raw.perEventType[0]);
		expect.soft(result.dailyTrend).not.toBe(raw.dailyTrend);
		expect.soft(result.dailyTrend[0]).not.toBe(raw.dailyTrend[0]);
		expectReads(requests, 1);
	});
	it.each([
		["HTTP503", () => json({ message: privateDetail, privateDiagnostic: privateDetail }, 503)],
		["network loss", () => Promise.reject(new Error(privateDetail))],
	] as const)(
		"keeps %s diagnostics out of Statistics read errors while permitting GET retries",
		async (_name, reply) => {
			const { client, requests } = fixture(reply);
			await settled(client);
			expectUnavailable(client);
			expectPublicError(client.getQueryState(key)?.error);
			expectReads(requests, 2);
		},
	);
});
