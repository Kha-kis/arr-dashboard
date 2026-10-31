import { QueryClient, QueryClientProvider } from "@tanstack/react-query";
import { act, cleanup, fireEvent, render, screen, waitFor, within } from "@testing-library/react";
import { afterEach, describe, expect, it, vi } from "vitest";
import { IncognitoProvider } from "../../../../contexts/IncognitoContext";
import { notificationKeys } from "../../../../lib/query-keys";
import { ColorThemeProvider } from "../../../../providers/color-theme-provider";
import { NotificationStatistics } from "../notification-statistics";

// Render the actual component, query, API projection and context providers.
// Replace only external transport. UI must not equate unobserved with empty,
// queued work with delivery, or stale cache with a successful current read.
const history = {
	period: { days: 30, since: "2026-09-06T12:00:00Z", until: "2026-10-06T12:00:00Z" },
	totals: { sent: 1, failed: 0, deadLetter: 0, unclassified: 0, total: 1, successRate: 100 },
	perChannel: [
		{
			channelId: "synthetic-channel",
			channelType: "DISCORD",
			sent: 1,
			failed: 0,
			unclassified: 0,
			successRate: 100,
		},
	],
	perEventType: [{ eventType: "HUNT_COMPLETED", count: 1 }],
	dailyTrend: [{ date: "2026-10-05", sent: 1, failed: 0, unclassified: 0 }],
};
const observed = {
	state: "observed",
	observedAt: "2026-10-06T12:01:00.000Z",
	events: { ready: 2, deferred: 3, aggregating: 4 },
	deliveries: { ready: 5, retryWaiting: 6, submitting: 7, uncertain: 8 },
	oldestDueAt: "2026-10-06T12:00:00.000Z",
};
const empty = {
	state: "observed",
	observedAt: "2026-10-06T12:02:00.000Z",
	events: { ready: 0, deferred: 0, aggregating: 0 },
	deliveries: { ready: 0, retryWaiting: 0, submitting: 0, uncertain: 0 },
	oldestDueAt: null,
};
const privateDetail = "synthetic-private-queue-ui-detail";
const key = notificationKeys.statistics(30);
const clients: QueryClient[] = [];
const pendingReads: Array<() => void> = [];
const violations: string[] = [];

function json(value: unknown, status = 200) {
	return new Response(JSON.stringify(value), {
		status,
		headers: { "Content-Type": "application/json" },
	});
}
function pending() {
	let resolve!: (value: Response) => void;
	const promise = new Promise<Response>((finish) => {
		resolve = finish;
	});
	pendingReads.push(() => resolve(json({ ...history, queue: empty })));
	return {
		promise,
		finish: async (value: unknown, status = 200) => act(async () => resolve(json(value, status))),
	};
}
function mount(read: () => Response | Promise<Response>) {
	const requests: string[] = [];
	let reply = read;
	vi.stubGlobal("fetch", (input: RequestInfo | URL, options: RequestInit = {}) => {
		const path = String(input);
		if (
			path !== "/api/notifications/statistics?days=30" ||
			options.method !== "GET" ||
			options.body !== undefined
		) {
			violations.push(path);
			throw new Error("Out-of-scope synthetic request");
		}
		requests.push(path);
		return reply();
	});
	const client = new QueryClient({
		defaultOptions: { queries: { retry: false, gcTime: 60_000, refetchOnWindowFocus: false } },
	});
	clients.push(client);
	render(
		<QueryClientProvider client={client}>
			<ColorThemeProvider>
				<IncognitoProvider>
					<NotificationStatistics />
				</IncognitoProvider>
			</ColorThemeProvider>
		</QueryClientProvider>,
	);
	return {
		client,
		requests,
		reply: (next: typeof read) => {
			reply = next;
		},
	};
}
async function settled(client: QueryClient) {
	await waitFor(() => {
		const state = client.getQueryState(key);
		expect(state?.fetchStatus).toBe("idle");
		expect(["success", "error"]).toContain(state?.status);
	});
}
function queue() {
	return screen.getByRole("region", { name: "Notification queue" });
}
function count(label: string) {
	return (
		within(queue()).queryByText(label, { selector: "dt" })?.nextElementSibling?.textContent ?? null
	);
}
function sent() {
	return (
		screen.queryByText("Total Sent", { selector: "p" })?.parentElement?.lastElementChild
			?.textContent ?? null
	);
}

afterEach(async () => {
	cleanup();
	await act(async () => {
		for (const release of pendingReads.splice(0)) release();
	});
	for (const client of clients.splice(0)) client.clear();
	vi.unstubAllGlobals();
	localStorage.clear();
	expect(violations.splice(0)).toEqual([]);
});

describe("notification queue through actual statistics reads and rendering", () => {
	it("does not infer active provider I/O from a durable submitting marker", async () => {
		const fixture = mount(() =>
			json({
				...history,
				queue: {
					...empty,
					events: { ready: 1, deferred: 0, aggregating: 0 },
					deliveries: { ready: 0, retryWaiting: 0, submitting: 1, uncertain: 0 },
				},
			}),
		);
		await settled(fixture.client);
		expect(queue()).not.toHaveTextContent(/are in progress|currently sending|delivery completed/i);
		expect(queue()).toHaveTextContent(/outcome.*unconfirmed/i);
		expect(queue()).toHaveTextContent(/progress.*unknown|cannot.*establish.*progress/i);
		expect(count("Submitting recipients")).toBe("1");
		expect(queue()).not.toHaveTextContent(/no queued or unconfirmed/i);
		expect(sent()).toBe("1");
		expect(fixture.requests).toHaveLength(1);
	});
	it("displays event and recipient units separately without changing History rates", async () => {
		const fixture = mount(() => json({ ...history, queue: observed }));
		await settled(fixture.client);
		expect(count("Ready events")).toBe("2");
		expect(count("Deferred events")).toBe("3");
		expect(count("Aggregating events")).toBe("4");
		expect(count("Ready recipients")).toBe("5");
		expect(count("Retry waiting recipients")).toBe("6");
		expect(count("Submitting recipients")).toBe("7");
		expect(count("Unconfirmed recipients")).toBe("8");
		expect(queue()).toHaveTextContent(/not automatically resent/i);
		expect(queue()).toHaveTextContent(/not.*delivery success rates/i);
		expect(
			within(queue()).getByText("2026-10-06T12:01:00.000Z", { selector: "time" }),
		).toHaveAttribute("dateTime", "2026-10-06T12:01:00.000Z");
		expect(
			within(queue()).getByText("2026-10-06T12:00:00.000Z", { selector: "time" }),
		).toBeInTheDocument();
		expect(sent()).toBe("1");
		expect(document.body).toHaveTextContent("100.0%");
		expect(fixture.requests).toHaveLength(1);
	});
	it("shows pending work even when no delivery History exists", async () => {
		const fixture = mount(() =>
			json({
				...history,
				totals: { sent: 0, failed: 0, deadLetter: 0, unclassified: 0, total: 0, successRate: 0 },
				perChannel: [],
				perEventType: [],
				dailyTrend: [],
				queue: observed,
			}),
		);
		await settled(fixture.client);
		expect(count("Aggregating events")).toBe("4");
		expect(sent()).toBe("0");
		expect(document.body).toHaveTextContent("Not measured");
	});
	it("calls a genuinely measured all-zero queue empty, including zero unconfirmed work", async () => {
		const fixture = mount(() => json({ ...history, queue: empty }));
		await settled(fixture.client);
		expect(count("Ready events")).toBe("0");
		expect(count("Unconfirmed recipients")).toBe("0");
		expect(queue()).toHaveTextContent(/no queued or unconfirmed work was observed/i);
		expect(queue()).not.toHaveTextContent(/status unavailable|not automatically resent/i);
		expect(queue()).not.toHaveTextContent("2026-10-06T12:00:00.000Z");
	});
	it.each([
		["legacy missing queue", { ...history }],
		[
			"provider-independent storage read failure",
			{ ...history, queue: { state: "unavailable", reason: "storage-unavailable" } },
		],
		[
			"unknown native state",
			{ ...history, queue: { state: "unavailable", reason: "state-unavailable" } },
		],
		["malformed queue", { ...history, queue: { ...observed, observedAt: privateDetail } }],
	])("makes %s unavailable while keeping valid History usable", async (_name, payload) => {
		const fixture = mount(() => json(payload));
		await settled(fixture.client);
		expect(queue()).toHaveTextContent(/queue status unavailable/i);
		expect(count("Ready events")).toBeNull();
		expect(queue()).not.toHaveTextContent(/no queued or unconfirmed/i);
		expect(sent()).toBe("1");
		expect(document.body).not.toHaveTextContent(privateDetail);
		expect(within(queue()).getByRole("button", { name: "Read queue status" })).toBeEnabled();
	});
	it("shows first-load progress without inventing counts and prevents duplicate reads", async () => {
		const read = pending();
		const fixture = mount(() => read.promise);
		expect(queue()).toHaveTextContent(/reading notification queue/i);
		expect(count("Ready events")).toBeNull();
		expect(within(queue()).getByRole("button", { name: "Read queue status" })).toBeDisabled();
		await read.finish({ ...history, queue: observed });
		await settled(fixture.client);
		expect(count("Ready events")).toBe("2");
		expect(queue()).not.toHaveTextContent(/reading notification queue|last-known/i);
	});
	it("recovers from an unavailable first GET with one explicit read, never a send", async () => {
		const fixture = mount(() => json({ error: privateDetail }, 503));
		await settled(fixture.client);
		expect(queue()).toHaveTextContent(/queue status unavailable/i);
		expect(count("Ready events")).toBeNull();
		expect(sent()).toBeNull();
		expect(document.body).not.toHaveTextContent(privateDetail);
		fixture.reply(() => json({ ...history, queue: observed }));
		fireEvent.click(within(queue()).getByRole("button", { name: "Read queue status" }));
		await waitFor(() => expect(count("Ready events")).toBe("2"));
		await settled(fixture.client);
		expect(queue()).not.toHaveTextContent(/status unavailable|last-known/i);
		expect(fixture.requests).toHaveLength(2);
	});
	it("labels cached counts last-known during refresh and failure, then replaces them on recovery", async () => {
		const fixture = mount(() => json({ ...history, queue: observed }));
		await settled(fixture.client);
		const read = pending();
		fixture.reply(() => read.promise);
		fireEvent.click(within(queue()).getByRole("button", { name: "Read queue status" }));
		await waitFor(() => expect(queue()).toHaveTextContent(/last-known queue.*refreshing/i));
		expect(count("Unconfirmed recipients")).toBe("8");
		expect(within(queue()).getByRole("button", { name: "Read queue status" })).toBeDisabled();
		await read.finish({ error: privateDetail }, 503);
		await settled(fixture.client);
		expect(queue()).toHaveTextContent(/last-known queue.*read failed/i);
		expect(count("Ready recipients")).toBe("5");
		expect(document.body).not.toHaveTextContent(privateDetail);
		fixture.reply(() => json({ ...history, queue: empty }));
		fireEvent.click(within(queue()).getByRole("button", { name: "Read queue status" }));
		await waitFor(() => expect(count("Ready events")).toBe("0"));
		await settled(fixture.client);
		expect(queue()).not.toHaveTextContent(/last-known|read failed|unavailable/i);
		expect(fixture.requests).toHaveLength(3);
	});
	it("shows generic queue evidence in incognito without retaining private wire extras", async () => {
		localStorage.setItem("arr-dashboard-incognito-mode", "true");
		const fixture = mount(() =>
			json({
				...history,
				queue: {
					...observed,
					payload: privateDetail,
					deliveries: { ...observed.deliveries, token: privateDetail },
				},
			}),
		);
		await settled(fixture.client);
		expect(count("Retry waiting recipients")).toBe("6");
		expect(document.body.innerHTML).not.toContain(privateDetail);
		expect(JSON.stringify(fixture.client.getQueryData(key))).not.toContain(privateDetail);
	});
});
