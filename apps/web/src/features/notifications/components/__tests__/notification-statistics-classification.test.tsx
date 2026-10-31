import { QueryClient, QueryClientProvider } from "@tanstack/react-query";
import { act, cleanup, fireEvent, render, screen, waitFor, within } from "@testing-library/react";
import { afterEach, describe, expect, it, vi } from "vitest";
import { IncognitoProvider } from "../../../../contexts/IncognitoContext";
import { notificationsApi } from "../../../../lib/api-client/notifications";
import {
	acknowledgeProtectedUnauthorized,
	getPendingUnauthorizedRevision,
} from "../../../../lib/auth-session-signal";
import { notificationKeys } from "../../../../lib/query-keys";
import { ColorThemeProvider } from "../../../../providers/color-theme-provider";
import { NotificationStatistics } from "../notification-statistics";

// Only transport is synthetic. Admission, query/cache, providers and renderer are real.
// These literal observations catch dropping unknown rows, inventing their outcome,
// certifying legacy denominators, or accepting inconsistent classification evidence.
const mixed = {
	period: { days: 30, since: "2026-03-01T12:00:00Z", until: "2026-03-31T11:00:00Z" },
	totals: { sent: 1, failed: 1, deadLetter: 1, unclassified: 1, total: 4, successRate: 33.33 },
	perChannel: [
		{
			channelId: "synthetic-channel",
			channelType: "LEGACY_MAIL",
			sent: 1,
			failed: 2,
			unclassified: 1,
			successRate: 33.33,
		},
	],
	perEventType: [
		{ eventType: "LEGACY_NOTICE", count: 3 },
		{ eventType: "HUNT_COMPLETED", count: 1 },
	],
	dailyTrend: [{ date: "2026-03-08", sent: 1, failed: 2, unclassified: 1 }],
};
const unknownOnly = {
	...mixed,
	totals: { sent: 0, failed: 0, deadLetter: 0, unclassified: 1, total: 1, successRate: 0 },
	perChannel: [
		{
			channelId: "synthetic-channel",
			channelType: "LEGACY_MAIL",
			sent: 0,
			failed: 0,
			unclassified: 1,
			successRate: 0,
		},
	],
	perEventType: [{ eventType: "LEGACY_NOTICE", count: 1 }],
	dailyTrend: [{ date: "2026-03-08", sent: 0, failed: 0, unclassified: 1 }],
};
const zero = {
	...mixed,
	totals: { sent: 0, failed: 0, deadLetter: 0, unclassified: 0, total: 0, successRate: 0 },
	perChannel: [],
	perEventType: [],
	dailyTrend: [],
};
const legacy = {
	...mixed,
	totals: { sent: 1, failed: 1, deadLetter: 1, total: 3, successRate: 33.33 },
	perChannel: [
		{
			channelId: "synthetic-channel",
			channelType: "LEGACY_MAIL",
			sent: 1,
			failed: 3,
			successRate: 25,
		},
	],
	dailyTrend: [{ date: "2026-03-08", sent: 1, failed: 3 }],
};
const clients: QueryClient[] = [];
const violations: string[] = [];
function json(value: unknown) {
	return new Response(JSON.stringify(value), { headers: { "Content-Type": "application/json" } });
}
function fixture(read: (path: string) => Response | Promise<Response>, mount = true) {
	const requests: string[] = [];
	vi.stubGlobal("fetch", (input: RequestInfo | URL, options: RequestInit = {}) => {
		const path = String(input);
		if (
			!/^\/api\/notifications\/statistics\?days=(7|30)$/.test(path) ||
			(options.method ?? "GET") !== "GET" ||
			options.body !== undefined
		)
			violations.push(path);
		expect(path).toMatch(/^\/api\/notifications\/statistics\?days=(7|30)$/);
		expect(options.method ?? "GET").toBe("GET");
		expect(options.body).toBeUndefined();
		requests.push(path);
		return read(path);
	});
	const client = new QueryClient({ defaultOptions: { queries: { retry: false, gcTime: 60_000 } } });
	clients.push(client);
	if (mount)
		render(
			<QueryClientProvider client={client}>
				<ColorThemeProvider>
					<IncognitoProvider>
						<NotificationStatistics />
					</IncognitoProvider>
				</ColorThemeProvider>
			</QueryClientProvider>,
		);
	return { client, requests };
}
function metric(label: string) {
	return (
		screen.queryByText(label, { selector: "p" })?.parentElement?.lastElementChild?.textContent ??
		null
	);
}
afterEach(() => {
	cleanup();
	for (const client of clients.splice(0)) client.clear();
	vi.unstubAllGlobals();
	localStorage.clear();
	acknowledgeProtectedUnauthorized(getPendingUnauthorizedRevision());
	expect(violations.splice(0)).toEqual([]);
});

describe("Notification statistics outcome classification through real reads and rendering", () => {
	it("keeps protected 401 signaling and exposes no private transport detail", async () => {
		acknowledgeProtectedUnauthorized(getPendingUnauthorizedRevision());
		const { client } = fixture(() => new Response("synthetic-private-401", { status: 401 }));
		await waitFor(() =>
			expect(client.getQueryState(notificationKeys.statistics(30))?.status).toBe("error"),
		);
		expect(getPendingUnauthorizedRevision()).toBeGreaterThan(0);
		expect(client.getQueryData(notificationKeys.statistics(30))).toBeUndefined();
		expect(document.body).not.toHaveTextContent("synthetic-private-401");
	});
	it("keeps classification visible in incognito without admitting private extras", async () => {
		localStorage.setItem("arr-dashboard-incognito-mode", "true");
		fixture(() =>
			json({
				...mixed,
				privateDetail: "synthetic-private-incognito",
				perChannel: mixed.perChannel.map((row) => ({
					...row,
					channelName: "synthetic-private-incognito",
				})),
				perEventType: mixed.perEventType.map((row) => ({
					...row,
					title: "synthetic-private-incognito",
				})),
			}),
		);
		await waitFor(() => expect(metric("Total Sent")).toBe("1"));
		expect(metric("Unclassified")).toBe("1");
		expect(document.body.innerHTML).not.toContain("synthetic-private-incognito");
	});
	it("renders mixed counts, classified rate, all-record event shares and accessible unknown bars", async () => {
		const { client } = fixture(() => json(mixed));
		await waitFor(() => expect(metric("Total Sent")).toBe("1"));
		expect.soft(client.getQueryData(notificationKeys.statistics(30))).toEqual(mixed);
		expect.soft(metric("Unclassified")).toBe("1");
		expect.soft(metric("Success Rate")).toBe("33.3%");
		expect.soft(document.body).toHaveTextContent(/among classified outcomes/i);
		expect.soft(document.body).toHaveTextContent(/failed.*including dead letters/i);
		expect
			.soft(
				screen.queryByRole("img", {
					name: /2026-03-08: 1 sent, 2 failed including dead letters, 1 unclassified/i,
				}),
			)
			.toBeInTheDocument();
		expect
			.soft(
				screen.queryByRole("img", {
					name: /LEGACY_MAIL: 1 sent, 2 failed including dead letters, 1 unclassified/i,
				}),
			)
			.toBeInTheDocument();
		expect
			.soft(screen.queryByLabelText("2026-03-08: 1 unclassified"))
			.toHaveStyle({ height: "25%" });
		expect
			.soft(screen.queryByLabelText("LEGACY_MAIL: 1 unclassified"))
			.toHaveStyle({ width: "25%" });
		expect.soft(screen.getByRole("row", { name: /LEGACY_NOTICE 3 75%/ })).toBeInTheDocument();
		expect.soft(screen.queryByRole("row", { name: /Hunt: Completed 1 25%/ })).toBeInTheDocument();
	});
	it("unknown-only is visible data with no measured success or confirmed failures", async () => {
		fixture(() => json(unknownOnly));
		await waitFor(() => expect(metric("Total Sent")).toBe("0"));
		expect.soft(metric("Unclassified")).toBe("1");
		expect.soft(metric("Failed")).toBe("0");
		expect.soft(metric("Success Rate")).toBe("Not measured");
		expect.soft(screen.queryByText("No statistics yet")).not.toBeInTheDocument();
		expect
			.soft(screen.queryByLabelText("2026-03-08: 1 unclassified"))
			.toHaveStyle({ height: "100%" });
		expect
			.soft(screen.queryByLabelText("LEGACY_MAIL: 1 unclassified"))
			.toHaveStyle({ width: "100%" });
		expect.soft(screen.queryByRole("row", { name: /LEGACY_NOTICE 1 100%/ })).toBeInTheDocument();
	});
	it("explicit valid zero remains a measured count, with an unmeasured rate", async () => {
		const { client } = fixture(() => json(zero));
		await waitFor(() => expect(metric("Total Sent")).toBe("0"));
		expect.soft(client.getQueryData(notificationKeys.statistics(30))).toEqual(zero);
		expect.soft(metric("Unclassified")).toBe("0");
		expect.soft(metric("Success Rate")).toBe("Not measured");
		expect.soft(document.body).not.toHaveTextContent("Classification unverified");
	});
	it("legacy observations keep literal counts but certify neither rate nor event shares", async () => {
		const { client } = fixture(() => json(legacy));
		await waitFor(() => expect(metric("Total Sent")).toBe("1"));
		expect(client.getQueryData(notificationKeys.statistics(30))).toEqual(legacy);
		expect.soft(metric("Unclassified")).toBe("Not verified");
		expect.soft(metric("Success Rate")).toBe("Not verified");
		expect.soft(document.body).toHaveTextContent(/classification unverified/i);
		expect.soft(document.body).not.toHaveTextContent(/33\.3%|25%|100%/);
		expect
			.soft(
				within(screen.getByRole("row", { name: /LEGACY_NOTICE 3/ })).queryByText("Not verified"),
			)
			.toBeInTheDocument();
	});
	it.each([
		["missing summary evidence", { ...mixed, totals: legacy.totals }],
		["missing channel evidence", { ...mixed, perChannel: legacy.perChannel }],
		["missing daily evidence", { ...mixed, dailyTrend: legacy.dailyTrend }],
		["negative unknown", { ...mixed, totals: { ...mixed.totals, unclassified: -1 } }],
		["fractional unknown", { ...mixed, totals: { ...mixed.totals, unclassified: 0.5 } }],
		[
			"unsafe unknown",
			{ ...mixed, totals: { ...mixed.totals, unclassified: Number.MAX_SAFE_INTEGER + 1 } },
		],
		["null unknown", { ...mixed, totals: { ...mixed.totals, unclassified: null } }],
		["unbalanced total", { ...mixed, totals: { ...mixed.totals, total: 3 } }],
		["all-record rate", { ...mixed, totals: { ...mixed.totals, successRate: 25 } }],
		[
			"incorrect channel rate",
			{ ...mixed, perChannel: [{ ...mixed.perChannel[0], successRate: 25 }] },
		],
		[
			"unsafe aggregate sum",
			{
				...mixed,
				totals: { ...mixed.totals, sent: Number.MAX_SAFE_INTEGER, total: Number.MAX_SAFE_INTEGER },
			},
		],
		["unbalanced events", { ...mixed, perEventType: [{ eventType: "LEGACY_NOTICE", count: 5 }] }],
		["unbalanced day", { ...mixed, dailyTrend: [{ ...mixed.dailyTrend[0], unclassified: 2 }] }],
		["unbalanced channel", { ...mixed, perChannel: [{ ...mixed.perChannel[0], unclassified: 2 }] }],
		[
			"invented unknown-only success",
			{ ...unknownOnly, totals: { ...unknownOnly.totals, successRate: 100 } },
		],
	] as const)("rejects %s before new cache or renderer admission", async (_name, value) => {
		const { client } = fixture(() => json(value));
		await waitFor(() =>
			expect(client.getQueryState(notificationKeys.statistics(30))?.status).toBe("error"),
		);
		expect(client.getQueryData(notificationKeys.statistics(30))).toBeUndefined();
		expect(metric("Total Sent")).toBeNull();
		expect(screen.getByRole("alert")).toHaveTextContent(/couldn't load notification statistics/i);
	});
	it("retains classified evidence after malformed refresh, GET-retries and switches to unknown-only period", async () => {
		let value: unknown = mixed;
		const { client, requests } = fixture((path) =>
			json(
				path.endsWith("=7")
					? { ...unknownOnly, period: { ...unknownOnly.period, days: 7 } }
					: value,
			),
		);
		await waitFor(() => expect(metric("Total Sent")).toBe("1"));
		const prior = client.getQueryData(notificationKeys.statistics(30)),
			time = client.getQueryState(notificationKeys.statistics(30))?.dataUpdatedAt;
		value = { ...mixed, totals: { ...mixed.totals, unclassified: -1 } };
		await act(async () => {
			await client.refetchQueries({ queryKey: notificationKeys.statistics(30) });
		});
		await waitFor(() =>
			expect(screen.getByRole("alert")).toHaveTextContent(/last-known statistics.*refresh failed/i),
		);
		expect(client.getQueryData(notificationKeys.statistics(30))).toBe(prior);
		expect(client.getQueryState(notificationKeys.statistics(30))?.dataUpdatedAt).toBe(time);
		expect(metric("Unclassified")).toBe("1");
		expect(metric("Success Rate")).toBe("33.3%");
		value = unknownOnly;
		fireEvent.click(screen.getByRole("button", { name: "Try again" }));
		await waitFor(() => expect(metric("Success Rate")).toBe("Not measured"));
		fireEvent.click(screen.getByRole("button", { name: "7d" }));
		await waitFor(() =>
			expect(client.getQueryState(notificationKeys.statistics(7))?.status).toBe("success"),
		);
		expect(metric("Unclassified")).toBe("1");
		expect(metric("Success Rate")).toBe("Not measured");
		expect(requests).toEqual([
			"/api/notifications/statistics?days=30",
			"/api/notifications/statistics?days=30",
			"/api/notifications/statistics?days=30",
			"/api/notifications/statistics?days=7",
		]);
	});
	it("real client copies explicit classification evidence and strips private extras", async () => {
		fixture(
			() =>
				json({
					...mixed,
					privateDetail: "synthetic-private",
					totals: { ...mixed.totals, privateDetail: "synthetic-private" },
				}),
			false,
		);
		const result = await notificationsApi.getStatistics(30);
		expect(result).toEqual(mixed);
		expect(JSON.stringify(result)).not.toContain("synthetic-private");
	});
});
