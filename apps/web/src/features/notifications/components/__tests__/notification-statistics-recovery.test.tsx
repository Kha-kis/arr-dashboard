import type { NotificationStatisticsResponse } from "@arr/shared";
import { QueryClient, QueryClientProvider } from "@tanstack/react-query";
import { act, cleanup, fireEvent, render, screen, waitFor, within } from "@testing-library/react";
import { afterEach, describe, expect, it, vi } from "vitest";
import { IncognitoProvider } from "../../../../contexts/IncognitoContext";
import { notificationKeys } from "../../../../lib/query-keys";
import { ColorThemeProvider } from "../../../../providers/color-theme-provider";
import { NotificationStatistics } from "../notification-statistics";

// Literal transport truth, independent of API aggregation and UI formatting.
// Only external fetch is replaced; component, queries, client and providers run.
const thirty: NotificationStatisticsResponse = {
	period: { days: 30, since: "2026-09-06T12:00:00Z", until: "2026-10-06T12:00:00Z" },
	totals: { sent: 8, failed: 2, deadLetter: 1, unclassified: 0, total: 11, successRate: 72.73 },
	perChannel: [
		{
			channelId: "synthetic-channel",
			channelType: "DISCORD",
			sent: 8,
			failed: 3,
			unclassified: 0,
			successRate: 72.73,
		},
	],
	perEventType: [
		{ eventType: "HUNT_COMPLETED", count: 10 },
		{ eventType: "BACKUP_FAILED", count: 1 },
	],
	dailyTrend: [{ date: "2026-10-05", sent: 8, failed: 3, unclassified: 0 }],
};
const recovered: NotificationStatisticsResponse = {
	period: { days: 30, since: "2026-09-06T12:00:00Z", until: "2026-10-06T12:00:00Z" },
	totals: { sent: 18, failed: 2, deadLetter: 1, unclassified: 0, total: 21, successRate: 85.71 },
	perChannel: [
		{
			channelId: "synthetic-channel",
			channelType: "DISCORD",
			sent: 18,
			failed: 3,
			unclassified: 0,
			successRate: 85.71,
		},
	],
	perEventType: [
		{ eventType: "HUNT_COMPLETED", count: 20 },
		{ eventType: "BACKUP_FAILED", count: 1 },
	],
	dailyTrend: [{ date: "2026-10-05", sent: 18, failed: 3, unclassified: 0 }],
};
const seven: NotificationStatisticsResponse = {
	period: { days: 7, since: "2026-09-29T12:00:00Z", until: "2026-10-06T12:00:00Z" },
	totals: { sent: 7, failed: 0, deadLetter: 0, total: 7, successRate: 100 },
	perChannel: [],
	perEventType: [],
	dailyTrend: [],
};
const fourteen: NotificationStatisticsResponse = {
	period: { days: 14, since: "2026-09-22T12:00:00Z", until: "2026-10-06T12:00:00Z" },
	totals: { sent: 14, failed: 0, deadLetter: 0, total: 14, successRate: 100 },
	perChannel: [],
	perEventType: [],
	dailyTrend: [],
};
const ninety: NotificationStatisticsResponse = {
	period: { days: 90, since: "2026-07-08T12:00:00Z", until: "2026-10-06T12:00:00Z" },
	totals: { sent: 90, failed: 0, deadLetter: 0, total: 90, successRate: 100 },
	perChannel: [],
	perEventType: [],
	dailyTrend: [],
};
// The transport's legacy zero-denominator sentinel must not imply a measured rate.
const zero: NotificationStatisticsResponse = {
	period: { days: 30, since: "2026-09-06T12:00:00Z", until: "2026-10-06T12:00:00Z" },
	totals: { sent: 0, failed: 0, deadLetter: 0, total: 0, successRate: 100 },
	perChannel: [
		{
			channelId: "synthetic-channel",
			channelType: "DISCORD",
			sent: 0,
			failed: 0,
			successRate: 100,
		},
	],
	perEventType: [],
	dailyTrend: [],
};
const privateError = "synthetic-private-statistics-detail";
const clients: QueryClient[] = [];
const releases: Array<() => void> = [];
const thirtyPath = "/api/notifications/statistics?days=30";

function json(value: unknown, status = 200) {
	return new Response(JSON.stringify(value), {
		status,
		headers: { "Content-Type": "application/json" },
	});
}

function pendingRead() {
	let resolve!: (response: Response) => void;
	const response = new Promise<Response>((finish) => {
		resolve = finish;
	});
	releases.push(() => resolve(json(thirty)));
	return {
		response,
		async finish(value: unknown, status = 200) {
			await act(async () => resolve(json(value, status)));
		},
	};
}

function transport(read: (path: string) => Response | Promise<Response>) {
	const requests: Array<{ path: string; method: string; body: BodyInit | null | undefined }> = [];
	vi.stubGlobal("fetch", async (input: RequestInfo | URL, options: RequestInit = {}) => {
		const path = String(input);
		if (!/^\/api\/notifications\/statistics\?days=(7|14|30|90)$/.test(path)) {
			throw new Error("Out-of-scope synthetic read");
		}
		requests.push({ path, method: options.method ?? "GET", body: options.body });
		if ((options.method ?? "GET") !== "GET" || options.body !== undefined) {
			throw new Error("Statistics recovery must only read");
		}
		return read(path);
	});
	return requests;
}

function mount(known?: NotificationStatisticsResponse) {
	const client = new QueryClient({ defaultOptions: { queries: { retry: false, gcTime: 60_000 } } });
	clients.push(client);
	if (known) client.setQueryData(notificationKeys.statistics(30), known);
	render(
		<QueryClientProvider client={client}>
			<ColorThemeProvider>
				<IncognitoProvider>
					<NotificationStatistics />
				</IncognitoProvider>
			</ColorThemeProvider>
		</QueryClientProvider>,
	);
	return client;
}

function metric(label: string) {
	return (
		screen.queryByText(label, { selector: "p" })?.parentElement?.lastElementChild?.textContent ??
		null
	);
}

afterEach(async () => {
	cleanup();
	await act(async () => {
		for (const release of releases.splice(0)) release();
	});
	for (const client of clients.splice(0)) client.clear();
	vi.unstubAllGlobals();
	localStorage.clear();
});

describe("Notification Statistics: actual read states and read-only recovery", () => {
	// Catches converting an API UTC calendar bucket into the previous local day.
	// Expectations are literal calendar labels, not derived with the UI formatter.
	it.each([
		["2024-02-29", "2/29", "2024-01-31T12:00:00Z", "2024-03-01T12:00:00Z"],
		["2026-03-08", "3/8", "2026-02-07T12:00:00Z", "2026-03-09T12:00:00Z"],
		["2026-03-09", "3/9", "2026-02-08T12:00:00Z", "2026-03-10T12:00:00Z"],
		["2026-11-01", "11/1", "2026-10-03T12:00:00Z", "2026-11-02T12:00:00Z"],
		["2026-11-02", "11/2", "2026-10-04T12:00:00Z", "2026-11-03T12:00:00Z"],
		["2026-01-01", "1/1", "2025-12-03T12:00:00Z", "2026-01-02T12:00:00Z"],
		["2026-12-31", "12/31", "2026-12-02T12:00:00Z", "2027-01-01T12:00:00Z"],
		["2026-04-01", "4/1", "2026-03-03T12:00:00Z", "2026-04-02T12:00:00Z"],
	])(
		"preserves UTC bucket %s in the visible daily-trend label",
		async (date, label, since, until) => {
			const payload: NotificationStatisticsResponse = {
				...thirty,
				period: { days: 30, since, until },
				dailyTrend: [{ date, sent: 8, failed: 3, unclassified: 0 }],
			};
			const requests = transport(() => json(payload));
			mount();
			const bucket = await screen.findByTitle(`${date}: 8 sent, 3 failed`);
			expect(within(bucket).getByText(label)).toBeInTheDocument();
			expect(metric("Total Sent")).toBe("8");
			expect(metric("Failed")).toBe("2");
			expect(metric("Dead Letter")).toBe("1");
			expect(metric("Success Rate")).toBe("72.7%");
			expect(requests).toEqual([{ path: thirtyPath, method: "GET", body: undefined }]);
		},
	);

	// Catches presenting UTC-grouped totals as unspecified local-day analytics.
	it("identifies the daily-trend calendar as UTC without changing delivery counts", async () => {
		transport(() => json(thirty));
		mount();
		await waitFor(() => expect(metric("Total Sent")).toBe("8"));
		expect(screen.getByRole("heading", { name: "Daily Trend (UTC)" })).toBeInTheDocument();
	});

	// Catches removing the UTC formatter option even when the CI host uses UTC.
	// Restore the process timezone immediately; the other cases exercise their
	// own process default rather than inheriting this western-zone fixture.
	it("preserves the UTC bucket under a western timezone independent of the CI default", async () => {
		vi.stubEnv("TZ", "America/Chicago");
		try {
			const requests = transport(() => json(thirty));
			mount();
			const bucket = await screen.findByTitle("2026-10-05: 8 sent, 3 failed");
			expect(within(bucket).getByText("10/5")).toBeInTheDocument();
			expect(requests).toEqual([{ path: thirtyPath, method: "GET", body: undefined }]);
		} finally {
			vi.unstubAllEnvs();
		}
	});

	// Catches treating cached values as freshly verified while a reread is pending.
	it("labels retained statistics last-known during a pending reread and replaces them on completion", async () => {
		const pending = pendingRead();
		const requests = transport(() => pending.response);
		const client = mount(thirty);
		act(() => {
			void client.refetchQueries({ queryKey: notificationKeys.statistics(30) });
		});
		await waitFor(() => expect(requests).toHaveLength(1));
		expect(client.getQueryState(notificationKeys.statistics(30))?.fetchStatus).toBe("fetching");
		expect(metric("Total Sent")).toBe("8");
		expect
			.soft(
				screen.queryByRole("status", { name: "Notification statistics refresh" })?.textContent ??
					"",
			)
			.toMatch(/last[- ]known.*refresh/i);
		await pending.finish(recovered);
		await waitFor(() => expect(metric("Total Sent")).toBe("18"));
		expect(
			screen.queryByRole("status", { name: "Notification statistics refresh" }),
		).not.toBeInTheDocument();
		expect(requests).toEqual([{ path: thirtyPath, method: "GET", body: undefined }]);
	});

	// Catches hiding cached metrics on read failure, leaking its error, or replaying a mutation.
	it("retains labeled last-known values on failed reread and recovers with one GET-only retry", async () => {
		let fail = true;
		const requests = transport(() =>
			fail ? json({ message: privateError }, 503) : json(recovered),
		);
		const client = mount(thirty);
		await act(async () => {
			await client.refetchQueries({ queryKey: notificationKeys.statistics(30) });
		});
		await waitFor(() => expect(screen.getByRole("alert")).toBeInTheDocument());
		expect(client.getQueryState(notificationKeys.statistics(30))?.status).toBe("error");
		expect.soft(metric("Total Sent")).toBe("8");
		expect.soft(metric("Failed")).toBe("2");
		expect.soft(metric("Success Rate")).toBe("72.7%");
		expect.soft(screen.queryByRole("alert")).toHaveTextContent(/last[- ]known.*refresh failed/i);
		expect.soft(screen.queryByText(privateError)).not.toBeInTheDocument();
		fail = false;
		fireEvent.click(screen.getByRole("button", { name: /retry|try again/i }));
		await waitFor(() => expect(metric("Total Sent")).toBe("18"));
		expect(metric("Success Rate")).toBe("85.7%");
		expect(screen.queryByRole("alert")).not.toBeInTheDocument();
		expect(requests).toEqual([
			{ path: thirtyPath, method: "GET", body: undefined },
			{ path: thirtyPath, method: "GET", body: undefined },
		]);
	});

	// Catches turning an initially failed read into known zeros or exposing private detail.
	it("keeps initially unavailable statistics unknown, shows a generic failure, and retries the read", async () => {
		const pending = pendingRead();
		let fail = true;
		const requests = transport(() => (fail ? pending.response : json(thirty)));
		const client = mount();
		await waitFor(() => expect(requests).toHaveLength(1));
		expect(
			screen.getAllByRole("status").some((node) => node.getAttribute("aria-busy") === "true"),
		).toBe(true);
		expect(metric("Total Sent")).toBeNull();
		await pending.finish({ message: privateError }, 503);
		await waitFor(() => expect(screen.getByRole("alert")).toBeInTheDocument());
		expect(client.getQueryData(notificationKeys.statistics(30))).toBeUndefined();
		expect(screen.getByRole("alert")).toHaveTextContent(/couldn't load.*statistics/i);
		expect.soft(screen.queryByText(privateError)).not.toBeInTheDocument();
		expect(metric("Total Sent")).toBeNull();
		expect(metric("Failed")).toBeNull();
		expect(metric("Success Rate")).toBeNull();
		expect(screen.queryByText(/no statistics yet/i)).not.toBeInTheDocument();
		fail = false;
		fireEvent.click(screen.getByRole("button", { name: /retry|try again/i }));
		await waitFor(() => expect(metric("Total Sent")).toBe("8"));
		expect(requests).toEqual([
			{ path: thirtyPath, method: "GET", body: undefined },
			{ path: thirtyPath, method: "GET", body: undefined },
		]);
	});

	// Catches a selector using the wrong API window or conflating period query keys.
	it("reads and renders distinct confirmed 7, 14, 30 and 90 day periods", async () => {
		const responses: Record<string, NotificationStatisticsResponse> = {
			"/api/notifications/statistics?days=7": seven,
			"/api/notifications/statistics?days=14": fourteen,
			"/api/notifications/statistics?days=30": thirty,
			"/api/notifications/statistics?days=90": ninety,
		};
		const requests = transport((path) => json(responses[path]));
		const client = mount();
		await waitFor(() => expect(metric("Total Sent")).toBe("8"));
		for (const [label, sent] of [
			["7d", "7"],
			["14d", "14"],
			["90d", "90"],
			["30d", "8"],
		] as const) {
			fireEvent.click(screen.getByRole("button", { name: label }));
			await waitFor(() => expect(metric("Total Sent")).toBe(sent));
		}
		expect(requests).toEqual([
			{ path: thirtyPath, method: "GET", body: undefined },
			{ path: "/api/notifications/statistics?days=7", method: "GET", body: undefined },
			{ path: "/api/notifications/statistics?days=14", method: "GET", body: undefined },
			{ path: "/api/notifications/statistics?days=90", method: "GET", body: undefined },
		]);
		expect(client.getQueryData(notificationKeys.statistics(7))).toEqual(seven);
		expect(client.getQueryData(notificationKeys.statistics(14))).toEqual(fourteen);
		expect(client.getQueryData(notificationKeys.statistics(30))).toEqual(thirty);
		expect(client.getQueryData(notificationKeys.statistics(90))).toEqual(ninety);
	});

	// Catches showing the previous period's values as current while a new period is unconfirmed.
	it("does not present the prior period as current during a pending or failed new-period read", async () => {
		const pending = pendingRead();
		let fail = true;
		const requests = transport(() => (fail ? pending.response : json(seven)));
		const client = mount(thirty);
		fireEvent.click(screen.getByRole("button", { name: "7d" }));
		await waitFor(() => expect(requests).toHaveLength(1));
		expect(metric("Total Sent")).toBeNull();
		expect(metric("Success Rate")).toBeNull();
		expect(screen.getAllByRole("status").length).toBeGreaterThan(0);
		await pending.finish({ message: privateError }, 503);
		await waitFor(() => expect(screen.getByRole("alert")).toBeInTheDocument());
		expect(metric("Total Sent")).toBeNull();
		expect(client.getQueryData(notificationKeys.statistics(7))).toBeUndefined();
		expect(client.getQueryData(notificationKeys.statistics(30))).toEqual(thirty);
		fail = false;
		fireEvent.click(screen.getByRole("button", { name: /retry|try again/i }));
		await waitFor(() => expect(metric("Total Sent")).toBe("7"));
		expect(requests).toEqual([
			{ path: "/api/notifications/statistics?days=7", method: "GET", body: undefined },
			{ path: "/api/notifications/statistics?days=7", method: "GET", body: undefined },
		]);
	});

	// Catches a late old-period reread replacing the newly selected period's metrics.
	it("keeps the selected period after an older period's pending reread completes", async () => {
		const pending = pendingRead();
		transport((path) => (path === thirtyPath ? pending.response : json(seven)));
		const client = mount(thirty);
		act(() => {
			void client.refetchQueries({ queryKey: notificationKeys.statistics(30) });
		});
		await waitFor(() =>
			expect(client.getQueryState(notificationKeys.statistics(30))?.fetchStatus).toBe("fetching"),
		);
		fireEvent.click(screen.getByRole("button", { name: "7d" }));
		await waitFor(() => expect(metric("Total Sent")).toBe("7"));
		await pending.finish(recovered);
		await waitFor(() =>
			expect(client.getQueryState(notificationKeys.statistics(30))?.fetchStatus).toBe("idle"),
		);
		expect(metric("Total Sent")).toBe("7");
		expect(client.getQueryData(notificationKeys.statistics(30))).toEqual(recovered);
	});

	// Catches interpreting an API zero-denominator sentinel as observed delivery success.
	it("renders confirmed zero counts without claiming a measured 100 percent success rate", async () => {
		transport(() => json(zero));
		mount();
		await waitFor(() => expect(metric("Total Sent")).toBe("0"));
		expect(metric("Failed")).toBe("0");
		expect(metric("Dead Letter")).toBe("0");
		expect.soft(metric("Success Rate")).not.toMatch(/100(?:\.0)?%/);
		expect.soft(screen.queryByText(/0\/0 sent.*100%/)).not.toBeInTheDocument();
	});

	// Catches incorrect nonzero summary counts/rates and dropped channel/event breakdowns.
	it("renders nonzero persisted totals, channel health and event breakdown truthfully", async () => {
		transport(() => json(thirty));
		mount();
		await waitFor(() => expect(metric("Total Sent")).toBe("8"));
		expect(metric("Failed")).toBe("2");
		expect(metric("Dead Letter")).toBe("1");
		expect(metric("Success Rate")).toBe("72.7%");
		expect(screen.getByText(/8\/11 sent.*72.7% among classified outcomes/)).toBeInTheDocument();
		expect(screen.getByRole("row", { name: /Hunt: Completed 10 91%/ })).toBeInTheDocument();
		expect(screen.getByRole("row", { name: /Backup: Failed 1 9%/ })).toBeInTheDocument();
	});
});
