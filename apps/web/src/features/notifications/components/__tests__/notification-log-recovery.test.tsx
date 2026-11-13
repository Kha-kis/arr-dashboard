import { QueryClient, QueryClientProvider } from "@tanstack/react-query";
import { act, cleanup, fireEvent, render, screen, waitFor, within } from "@testing-library/react";
import { afterEach, describe, expect, it, vi } from "vitest";
import { IncognitoProvider } from "../../../../contexts/IncognitoContext";
import type { PaginatedLogs } from "../../../../lib/api-client/notifications";
import { notificationKeys } from "../../../../lib/query-keys";
import { ColorThemeProvider } from "../../../../providers/color-theme-provider";
import { NotificationLogTable } from "../notification-log-table";

// Hand-checked transport fixtures; only external fetch is replaced. The real
// component, hooks, API client, query cache, theme and incognito providers run.
const first: PaginatedLogs = {
	logs: [
		{
			id: "synthetic-sent",
			channelId: "synthetic-channel",
			channelType: "DISCORD",
			eventType: "HUNT_COMPLETED",
			title: "Synthetic sent title",
			body: "Synthetic sent body",
			status: "sent",
			error: null,
			retryCount: 0,
			sentAt: "2026-10-05T12:00:00Z",
		},
		{
			id: "synthetic-failed",
			channelId: "synthetic-channel",
			channelType: "DISCORD",
			eventType: "BACKUP_FAILED",
			title: "Synthetic failed title",
			body: "Synthetic failed body",
			status: "failed",
			error: "Synthetic delivery failed",
			retryCount: 1,
			sentAt: "2026-10-05T11:00:00Z",
		},
		{
			id: "synthetic-dead",
			channelId: "synthetic-channel",
			channelType: "DISCORD",
			eventType: "HUNT_FAILED",
			title: "Synthetic dead letter title",
			body: "Synthetic dead letter body",
			status: "dead_letter",
			error: "Synthetic delivery exhausted",
			retryCount: 3,
			sentAt: "2026-10-05T10:00:00Z",
		},
	],
	total: 30,
	page: 1,
	limit: 15,
};
const second: PaginatedLogs = {
	logs: [
		{
			id: "synthetic-second",
			channelId: "synthetic-channel",
			channelType: "DISCORD",
			eventType: "HUNT_COMPLETED",
			title: "Synthetic second page title",
			body: "Synthetic second page body",
			status: "sent",
			error: null,
			retryCount: 0,
			sentAt: "2026-10-04T12:00:00Z",
		},
	],
	total: 30,
	page: 2,
	limit: 15,
};
const failed: PaginatedLogs = {
	logs: [
		{
			id: "synthetic-filtered",
			channelId: "synthetic-channel",
			channelType: "DISCORD",
			eventType: "BACKUP_FAILED",
			title: "Synthetic filtered failure title",
			body: "Synthetic filtered failure body",
			status: "failed",
			error: "Synthetic failure",
			retryCount: 1,
			sentAt: "2026-10-03T12:00:00Z",
		},
	],
	total: 30,
	page: 1,
	limit: 15,
};
const failedSecond: PaginatedLogs = {
	logs: [
		{
			id: "synthetic-filtered-second",
			channelId: "synthetic-channel",
			channelType: "DISCORD",
			eventType: "BACKUP_FAILED",
			title: "Synthetic filtered second page title",
			body: "Synthetic filtered second page body",
			status: "failed",
			error: "Synthetic failure",
			retryCount: 2,
			sentAt: "2026-10-02T12:00:00Z",
		},
	],
	total: 30,
	page: 2,
	limit: 15,
};
const huntFailure: PaginatedLogs = {
	logs: [
		{
			id: "synthetic-hunt-filtered",
			channelId: "synthetic-channel",
			channelType: "DISCORD",
			eventType: "HUNT_COMPLETED",
			title: "Synthetic combined filter title",
			body: "Synthetic combined filter body",
			status: "failed",
			error: "Synthetic failure",
			retryCount: 1,
			sentAt: "2026-10-01T12:00:00Z",
		},
	],
	total: 1,
	page: 1,
	limit: 15,
};
const hunt: PaginatedLogs = {
	logs: [
		{
			id: "synthetic-hunt",
			channelId: "synthetic-channel",
			channelType: "DISCORD",
			eventType: "HUNT_COMPLETED",
			title: "Synthetic event filter title",
			body: "Synthetic event filter body",
			status: "sent",
			error: null,
			retryCount: 0,
			sentAt: "2026-10-01T11:00:00Z",
		},
	],
	total: 1,
	page: 1,
	limit: 15,
};
const recovered: PaginatedLogs = {
	logs: [
		{
			id: "synthetic-recovered",
			channelId: "synthetic-channel",
			channelType: "DISCORD",
			eventType: "HUNT_COMPLETED",
			title: "Synthetic recovered title",
			body: "Synthetic recovered body",
			status: "sent",
			error: null,
			retryCount: 0,
			sentAt: "2026-10-06T12:00:00Z",
		},
	],
	total: 1,
	page: 1,
	limit: 15,
};
const recoveredFiltered: PaginatedLogs = {
	logs: [
		{
			id: "synthetic-filtered-recovered",
			channelId: "synthetic-channel",
			channelType: "DISCORD",
			eventType: "BACKUP_FAILED",
			title: "Synthetic filtered recovered title",
			body: "Synthetic filtered recovered body",
			status: "failed",
			error: "Synthetic failure",
			retryCount: 1,
			sentAt: "2026-10-06T12:00:00Z",
		},
	],
	total: 1,
	page: 1,
	limit: 15,
};
const empty: PaginatedLogs = { logs: [], total: 0, page: 1, limit: 15 };
const vanishedLaterPage: PaginatedLogs = { logs: [], total: 1, page: 2, limit: 15 };
const privateReadError = "synthetic-private-history-read-detail";
const firstPath = "/api/notifications/logs?page=1&limit=15";
const secondPath = "/api/notifications/logs?page=2&limit=15";
const failedPath = "/api/notifications/logs?page=1&limit=15&status=failed";
const failedSecondPath = "/api/notifications/logs?page=2&limit=15&status=failed";
const combinedPath =
	"/api/notifications/logs?page=1&limit=15&status=failed&eventType=HUNT_COMPLETED";
const combinedSecondPath =
	"/api/notifications/logs?page=2&limit=15&status=failed&eventType=HUNT_COMPLETED";
const eventPath = "/api/notifications/logs?page=1&limit=15&eventType=HUNT_COMPLETED";
const clients: QueryClient[] = [];
const releases: Array<() => void> = [];

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
	releases.push(() => resolve(json(empty)));
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
		if (
			![
				firstPath,
				secondPath,
				failedPath,
				failedSecondPath,
				combinedPath,
				combinedSecondPath,
				eventPath,
			].includes(path)
		) {
			throw new Error("Out-of-scope synthetic history read");
		}
		requests.push({ path, method: options.method ?? "GET", body: options.body });
		if ((options.method ?? "GET") !== "GET" || options.body !== undefined)
			throw new Error("History recovery must only read");
		return read(path);
	});
	return requests;
}

function mount(known?: PaginatedLogs, productionQueryDefaults = false) {
	const client = new QueryClient({
		defaultOptions: {
			queries: {
				retry: productionQueryDefaults ? 1 : false,
				staleTime: productionQueryDefaults ? 30_000 : 0,
				gcTime: 60_000,
			},
		},
	});
	clients.push(client);
	if (known) client.setQueryData(notificationKeys.logs(1, {}), known);
	render(
		<QueryClientProvider client={client}>
			<ColorThemeProvider>
				<IncognitoProvider>
					<NotificationLogTable />
				</IncognitoProvider>
			</ColorThemeProvider>
		</QueryClientProvider>,
	);
	return client;
}

// Existing pagination controls have no accessible names. Navigation uses the
// visible page indicator's parent so failures diagnose behavior, not selectors.
function navigate(pageLabel: string, direction: "previous" | "next") {
	const parent = screen.getByText(pageLabel).parentElement;
	if (!parent) throw new Error("History page indicator has no navigation parent");
	const buttons = within(parent).getAllByRole("button");
	expect(buttons).toHaveLength(2);
	fireEvent.click(buttons[direction === "previous" ? 0 : 1]!);
}

function assertReads(requests: ReturnType<typeof transport>, paths: string[]) {
	expect(requests).toEqual(paths.map((path) => ({ path, method: "GET", body: undefined })));
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

describe("Notification History: actual read states and read-only recovery", () => {
	// Catches visually present but unnamed navigation/filter controls, preventing
	// assistive-technology users from selecting the same read-only history paths.
	it("names page and event controls and exposes the selected status", async () => {
		const requests = transport((path) => json(path === secondPath ? second : first));
		mount();
		await waitFor(() => expect(screen.getByText("Synthetic sent title")).toBeInTheDocument());
		expect(screen.getByRole("button", { name: "All" })).toHaveAttribute("aria-pressed", "true");
		expect(screen.getByRole("button", { name: "Failed" })).toHaveAttribute("aria-pressed", "false");
		expect(screen.getByRole("combobox", { name: "Event type" })).toHaveValue("");
		expect(screen.getByRole("button", { name: "Previous page" })).toBeDisabled();
		fireEvent.click(screen.getByRole("button", { name: "Next page" }));
		await waitFor(() =>
			expect(screen.getByText("Synthetic second page title")).toBeInTheDocument(),
		);
		expect(screen.getByRole("button", { name: "Next page" })).toBeDisabled();
		fireEvent.click(screen.getByRole("button", { name: "Previous page" }));
		await waitFor(() => expect(requests).toHaveLength(3));
		expect(screen.getByText("Synthetic sent title")).toBeInTheDocument();
		assertReads(requests, [firstPath, secondPath, firstPath]);
	});

	// Catches presenting cached rows as verified current during an outstanding read.
	it("retains labeled last-known rows while a reread is pending and replaces them on completion", async () => {
		const pending = pendingRead();
		const requests = transport(() => pending.response);
		const client = mount(first);
		await waitFor(() => expect(requests).toHaveLength(1));
		expect(client.getQueryState(notificationKeys.logs(1, {}))?.fetchStatus).toBe("fetching");
		expect(screen.getByText("Synthetic sent title")).toBeInTheDocument();
		expect(screen.getByText("Synthetic failed title")).toBeInTheDocument();
		expect(screen.getByText("Synthetic dead letter title")).toBeInTheDocument();
		expect.soft(screen.queryByRole("status")?.textContent ?? "").toMatch(/last[- ]known.*refresh/i);
		await pending.finish(recovered);
		await waitFor(() => expect(screen.getByText("Synthetic recovered title")).toBeInTheDocument());
		expect(screen.queryByText("Synthetic sent title")).not.toBeInTheDocument();
		expect(screen.queryByRole("status")).not.toBeInTheDocument();
		assertReads(requests, [firstPath]);
	});

	// Catches replacing known history with a failure-only card or leaking raw detail.
	it("retains labeled last-known rows after a failed reread and recovers with one GET-only retry", async () => {
		let fail = true;
		const requests = transport(() =>
			fail ? json({ message: privateReadError }, 503) : json(recovered),
		);
		const client = mount(first);
		await waitFor(() => expect(screen.getByRole("alert")).toBeInTheDocument());
		expect(client.getQueryState(notificationKeys.logs(1, {}))?.status).toBe("error");
		expect.soft(screen.queryByText("Synthetic sent title")).toBeInTheDocument();
		expect.soft(screen.queryByText("Synthetic failed title")).toBeInTheDocument();
		expect.soft(screen.queryByText("Synthetic dead letter title")).toBeInTheDocument();
		expect.soft(screen.getByRole("alert")).toHaveTextContent(/last[- ]known.*refresh failed/i);
		expect.soft(screen.queryByText(privateReadError)).not.toBeInTheDocument();
		fail = false;
		fireEvent.click(screen.getByRole("button", { name: /retry|try again/i }));
		await waitFor(() => expect(screen.getByText("Synthetic recovered title")).toBeInTheDocument());
		expect(screen.queryByRole("alert")).not.toBeInTheDocument();
		assertReads(requests, [firstPath, firstPath]);
	});

	// Catches treating failed first reads as confirmed emptiness or replaying writes.
	it("keeps unavailable initial history unknown, sanitizes the read error, and retries GET", async () => {
		const pending = pendingRead();
		let fail = true;
		const requests = transport(() => (fail ? pending.response : json(first)));
		const client = mount();
		await waitFor(() => expect(requests).toHaveLength(1));
		expect(screen.getByRole("status", { busy: true })).toHaveAttribute("aria-busy", "true");
		expect(screen.queryByRole("table")).not.toBeInTheDocument();
		await pending.finish({ message: privateReadError }, 503);
		await waitFor(() => expect(screen.getByRole("alert")).toBeInTheDocument());
		expect(client.getQueryData(notificationKeys.logs(1, {}))).toBeUndefined();
		expect(screen.getByRole("alert")).toHaveTextContent(/couldn't load notification logs/i);
		expect.soft(screen.queryByText(privateReadError)).not.toBeInTheDocument();
		expect(screen.queryByText("No notification logs yet")).not.toBeInTheDocument();
		fail = false;
		fireEvent.click(screen.getByRole("button", { name: /retry|try again/i }));
		await waitFor(() => expect(screen.getByText("Synthetic sent title")).toBeInTheDocument());
		assertReads(requests, [firstPath, firstPath]);
	});

	// Catches reversed pagination, wrong page parameters or a merged page cache.
	it("navigates both directions with distinct page requests and cached rows", async () => {
		const requests = transport((path) => json(path === secondPath ? second : first));
		const client = mount();
		await waitFor(() => expect(screen.getByText("Synthetic sent title")).toBeInTheDocument());
		navigate("Page 1 of 2", "next");
		await waitFor(() =>
			expect(screen.getByText("Synthetic second page title")).toBeInTheDocument(),
		);
		expect(screen.queryByText("Synthetic sent title")).not.toBeInTheDocument();
		navigate("Page 2 of 2", "previous");
		await waitFor(() => expect(requests).toHaveLength(3));
		expect(screen.getByText("Synthetic sent title")).toBeInTheDocument();
		expect(client.getQueryData(notificationKeys.logs(1, {}))).toEqual(first);
		expect(client.getQueryData(notificationKeys.logs(2, {}))).toEqual(second);
		assertReads(requests, [firstPath, secondPath, firstPath]);
	});

	// Catches forgotten page reset, dropped combined filters and cache collisions.
	it("resets page for status and event filters, preserves the other filter, and clears both", async () => {
		const responses: Record<string, PaginatedLogs> = {
			[firstPath]: first,
			[secondPath]: second,
			[failedPath]: failed,
			[failedSecondPath]: failedSecond,
			[combinedPath]: huntFailure,
			[eventPath]: hunt,
		};
		const requests = transport((path) => json(responses[path]));
		const client = mount();
		await waitFor(() => expect(screen.getByText("Synthetic sent title")).toBeInTheDocument());
		navigate("Page 1 of 2", "next");
		await waitFor(() =>
			expect(screen.getByText("Synthetic second page title")).toBeInTheDocument(),
		);
		fireEvent.click(screen.getByRole("button", { name: "Failed" }));
		await waitFor(() =>
			expect(screen.getByText("Synthetic filtered failure title")).toBeInTheDocument(),
		);
		expect(screen.getByText("Page 1 of 2")).toBeInTheDocument();
		navigate("Page 1 of 2", "next");
		await waitFor(() =>
			expect(screen.getByText("Synthetic filtered second page title")).toBeInTheDocument(),
		);
		fireEvent.change(screen.getByRole("combobox"), { target: { value: "HUNT_COMPLETED" } });
		await waitFor(() =>
			expect(screen.getByText("Synthetic combined filter title")).toBeInTheDocument(),
		);
		fireEvent.click(screen.getByRole("button", { name: "All" }));
		await waitFor(() =>
			expect(screen.getByText("Synthetic event filter title")).toBeInTheDocument(),
		);
		expect(screen.getByRole("combobox")).toHaveValue("HUNT_COMPLETED");
		fireEvent.click(screen.getByRole("button", { name: "Clear" }));
		await waitFor(() => expect(requests).toHaveLength(7));
		expect(screen.getByText("Synthetic sent title")).toBeInTheDocument();
		expect(screen.getByRole("combobox")).toHaveValue("");
		expect(screen.queryByRole("button", { name: "Clear" })).not.toBeInTheDocument();
		expect(client.getQueryData(notificationKeys.logs(1, { status: "failed" }))).toEqual(failed);
		expect(client.getQueryData(notificationKeys.logs(2, { status: "failed" }))).toEqual(
			failedSecond,
		);
		expect(
			client.getQueryData(
				notificationKeys.logs(1, { status: "failed", eventType: "HUNT_COMPLETED" }),
			),
		).toEqual(huntFailure);
		expect(client.getQueryData(notificationKeys.logs(1, { eventType: "HUNT_COMPLETED" }))).toEqual(
			hunt,
		);
		assertReads(requests, [
			firstPath,
			secondPath,
			failedPath,
			failedSecondPath,
			combinedPath,
			eventPath,
			firstPath,
		]);
	});

	// Catches late old-page completion replacing a newly selected filter's rows.
	it("isolates a late page read from the selected filter and keeps both cache entries", async () => {
		const pending = pendingRead();
		const requests = transport((path) =>
			path === secondPath ? pending.response : json(path === failedPath ? failed : first),
		);
		const client = mount();
		await waitFor(() => expect(screen.getByText("Synthetic sent title")).toBeInTheDocument());
		navigate("Page 1 of 2", "next");
		await waitFor(() => expect(requests).toHaveLength(2));
		expect(screen.queryByText("Synthetic sent title")).not.toBeInTheDocument();
		fireEvent.click(screen.getByRole("button", { name: "Failed" }));
		await waitFor(() =>
			expect(screen.getByText("Synthetic filtered failure title")).toBeInTheDocument(),
		);
		await pending.finish(second);
		await waitFor(() => expect(client.getQueryData(notificationKeys.logs(2, {}))).toEqual(second));
		expect(screen.getByText("Synthetic filtered failure title")).toBeInTheDocument();
		expect(screen.getByText("Page 1 of 2")).toBeInTheDocument();
		expect(screen.queryByText("Synthetic second page title")).not.toBeInTheDocument();
		expect(client.getQueryData(notificationKeys.logs(1, { status: "failed" }))).toEqual(failed);
		assertReads(requests, [firstPath, secondPath, failedPath]);
	});

	// Catches presenting known unfiltered rows as evidence for an unknown filter.
	it("keeps a pending or failed new filter unknown and recovers without using another filter's rows", async () => {
		const pending = pendingRead();
		let fail = true;
		const requests = transport((path) =>
			path === firstPath ? json(first) : fail ? pending.response : json(failed),
		);
		const client = mount();
		await waitFor(() => expect(screen.getByText("Synthetic sent title")).toBeInTheDocument());
		fireEvent.click(screen.getByRole("button", { name: "Failed" }));
		await waitFor(() => expect(requests).toHaveLength(2));
		expect(screen.queryByRole("table")).not.toBeInTheDocument();
		expect(screen.getByRole("status", { busy: true })).toHaveAttribute("aria-busy", "true");
		await pending.finish({ message: privateReadError }, 503);
		await waitFor(() => expect(screen.getByRole("alert")).toBeInTheDocument());
		expect(screen.queryByText("Synthetic sent title")).not.toBeInTheDocument();
		expect(screen.queryByText("No matching logs")).not.toBeInTheDocument();
		expect(client.getQueryData(notificationKeys.logs(1, { status: "failed" }))).toBeUndefined();
		expect(client.getQueryData(notificationKeys.logs(1, {}))).toEqual(first);
		fail = false;
		fireEvent.click(screen.getByRole("button", { name: /retry|try again/i }));
		await waitFor(() =>
			expect(screen.getByText("Synthetic filtered failure title")).toBeInTheDocument(),
		);
		assertReads(requests, [firstPath, failedPath, failedPath]);
	});

	// Catches false global emptiness and a navigation dead end after page shrinkage.
	it.each([false, true])(
		"offers read-only return to first page for positive-total empty later page (filtered=%s)",
		async (filtered) => {
			const requests = transport((path) =>
				json(
					path === secondPath || path === failedSecondPath
						? vanishedLaterPage
						: filtered && path === failedPath
							? failed
							: first,
				),
			);
			mount();
			await waitFor(() => expect(screen.getByText("Synthetic sent title")).toBeInTheDocument());
			if (filtered) {
				fireEvent.click(screen.getByRole("button", { name: "Failed" }));
				await waitFor(() =>
					expect(screen.getByText("Synthetic filtered failure title")).toBeInTheDocument(),
				);
			}
			navigate("Page 1 of 2", "next");
			await waitFor(() => expect(requests).toHaveLength(filtered ? 3 : 2));
			await waitFor(() => expect(screen.queryByRole("table")).not.toBeInTheDocument());
			await waitFor(() =>
				expect(screen.queryByRole("status", { busy: true })).not.toBeInTheDocument(),
			);
			expect.soft(screen.queryByText("No notification logs yet")).not.toBeInTheDocument();
			expect.soft(screen.queryByText("No matching logs")).not.toBeInTheDocument();
			expect.soft(screen.queryByText(/no logs on this page|this page.*empty/i)).toBeInTheDocument();
			const returnAction = screen.queryByRole("button", { name: /first page|page 1/i });
			expect.soft(returnAction).toBeInTheDocument();
			if (returnAction) {
				fireEvent.click(returnAction);
				await waitFor(() => expect(requests).toHaveLength(filtered ? 4 : 3));
				expect(
					screen.getByText(filtered ? "Synthetic filtered failure title" : "Synthetic sent title"),
				).toBeInTheDocument();
				assertReads(
					requests,
					filtered
						? [firstPath, failedPath, failedSecondPath, failedPath]
						: [firstPath, secondPath, firstPath],
				);
			} else {
				// Keep the literal behavior RED; do not manufacture the missing action.
				assertReads(
					requests,
					filtered ? [firstPath, failedPath, failedSecondPath] : [firstPath, secondPath],
				);
			}
		},
	);

	// RHR-01: unlike normal navigation, explicit recovery must reread even a
	// fresh first-page cache after the later page contradicts its total count.
	it.each([false, true])(
		"rereads first-page recovery with production freshness defaults (filtered=%s)",
		async (filtered) => {
			const pending = pendingRead();
			let firstPageReads = 0;
			const recoveryPath = filtered ? failedPath : firstPath;
			const requests = transport((path) => {
				if (path === secondPath || path === failedSecondPath) return json(vanishedLaterPage);
				if (path === recoveryPath && ++firstPageReads > 1) return pending.response;
				return json(path === failedPath ? failed : first);
			});
			const client = mount(undefined, true);
			await waitFor(() => expect(screen.getByText("Synthetic sent title")).toBeInTheDocument());
			if (filtered) {
				fireEvent.click(screen.getByRole("button", { name: "Failed" }));
				await waitFor(() =>
					expect(screen.getByText("Synthetic filtered failure title")).toBeInTheDocument(),
				);
			}
			fireEvent.click(screen.getByRole("button", { name: "Next page" }));
			await waitFor(() =>
				expect(screen.getByRole("button", { name: "Back to first page" })).toBeInTheDocument(),
			);
			expect(
				client.getQueryData(notificationKeys.logs(1, filtered ? { status: "failed" } : {})),
			).toMatchObject({ total: 30 });
			fireEvent.click(screen.getByRole("button", { name: "Back to first page" }));
			await waitFor(() => expect(requests).toHaveLength(filtered ? 4 : 3));
			expect(screen.getByRole("status")).toHaveTextContent(/last[- ]known.*refresh/i);
			if (filtered)
				expect(client.getQueryState(notificationKeys.logs(1, {}))?.isInvalidated).toBe(false);
			expect(
				client.getQueryState(notificationKeys.logs(2, filtered ? { status: "failed" } : {}))
					?.isInvalidated,
			).toBe(false);
			await pending.finish(filtered ? recoveredFiltered : recovered);
			await waitFor(() =>
				expect(
					screen.getByText(
						filtered ? "Synthetic filtered recovered title" : "Synthetic recovered title",
					),
				).toBeInTheDocument(),
			);
			expect(screen.queryByText("Page 1 of 2")).not.toBeInTheDocument();
			expect(screen.queryByRole("status")).not.toBeInTheDocument();
			assertReads(
				requests,
				filtered
					? [firstPath, failedPath, failedSecondPath, failedPath]
					: [firstPath, secondPath, firstPath],
			);
		},
	);

	// Catches dropping explicit freshness recovery, hiding known rows on its
	// failed reread, leaking raw details, or losing the selected combined scope.
	// Keep the real production retry/backoff: one automatic retry fails before
	// the operator's separate GET succeeds, never by replaying a write.
	it.each(["all", "failed", "combined"] as const)(
		"retains selected last-known History after failed first-page recovery (scope=%s)",
		async (scope) => {
			const recoveryPending = pendingRead();
			const retryPending = pendingRead();
			const combinedFirst: PaginatedLogs = { ...huntFailure, total: 30 };
			const combinedRecovered: PaginatedLogs = {
				...recoveredFiltered,
				logs: [
					{
						...recoveredFiltered.logs[0]!,
						eventType: "HUNT_COMPLETED",
						title: "Synthetic combined recovered title",
					},
				],
			};
			const selectedFilters: Record<string, string> =
				scope === "combined"
					? { status: "failed", eventType: "HUNT_COMPLETED" }
					: scope === "failed"
						? { status: "failed" }
						: {};
			const recoveryPath =
				scope === "combined" ? combinedPath : scope === "failed" ? failedPath : firstPath;
			const known = scope === "combined" ? combinedFirst : scope === "failed" ? failed : first;
			const knownTitle =
				scope === "combined"
					? "Synthetic combined filter title"
					: scope === "failed"
						? "Synthetic filtered failure title"
						: "Synthetic sent title";
			let selectedReads = 0;
			const requests = transport((path) => {
				if ([secondPath, failedSecondPath, combinedSecondPath].includes(path))
					return json(vanishedLaterPage);
				if (path === recoveryPath) {
					selectedReads++;
					if (selectedReads === 2) return recoveryPending.response;
					if (selectedReads === 3) return json({ message: privateReadError }, 503);
					if (selectedReads >= 4) return retryPending.response;
				}
				return json(path === combinedPath ? combinedFirst : path === failedPath ? failed : first);
			});
			const client = mount(undefined, true);
			await screen.findByText("Synthetic sent title");
			if (scope !== "all") {
				fireEvent.click(screen.getByRole("button", { name: "Failed" }));
				await screen.findByText("Synthetic filtered failure title");
			}
			if (scope === "combined") {
				fireEvent.change(screen.getByRole("combobox", { name: "Event type" }), {
					target: { value: "HUNT_COMPLETED" },
				});
				await screen.findByText("Synthetic combined filter title");
			}
			fireEvent.click(screen.getByRole("button", { name: "Next page" }));
			await screen.findByRole("button", { name: "Back to first page" });
			expect(client.getQueryData(notificationKeys.logs(1, selectedFilters))).toEqual(known);
			fireEvent.click(screen.getByRole("button", { name: "Back to first page" }));
			await waitFor(() => expect(selectedReads).toBe(2));
			expect(screen.getByText(knownTitle)).toBeInTheDocument();
			expect(screen.getByRole("status", { busy: true })).toHaveTextContent(
				/last[- ]known.*refresh/i,
			);
			await recoveryPending.finish({ message: privateReadError }, 503);
			await waitFor(
				() => expect(screen.getByRole("alert")).toHaveTextContent(/last[- ]known.*refresh failed/i),
				{ timeout: 3_500 },
			);
			expect(selectedReads).toBe(3);
			expect(client.getQueryState(notificationKeys.logs(1, selectedFilters))?.status).toBe("error");
			expect(client.getQueryData(notificationKeys.logs(1, selectedFilters))).toEqual(known);
			expect(screen.getByText(knownTitle)).toBeInTheDocument();
			expect(document.body).not.toHaveTextContent(privateReadError);
			expect(screen.queryByText("No notification logs yet")).not.toBeInTheDocument();
			expect(screen.queryByText("No matching logs")).not.toBeInTheDocument();
			expect(
				screen.getByRole("button", { name: scope === "all" ? "All" : "Failed" }),
			).toHaveAttribute("aria-pressed", "true");
			expect(screen.getByRole("combobox", { name: "Event type" })).toHaveValue(
				scope === "combined" ? "HUNT_COMPLETED" : "",
			);
			if (scope !== "all") {
				expect(client.getQueryData(notificationKeys.logs(1, {}))).toEqual(first);
				expect(client.getQueryState(notificationKeys.logs(1, {}))?.isInvalidated).toBe(false);
				expect(screen.queryByText("Synthetic sent title")).not.toBeInTheDocument();
			}
			if (scope === "combined") {
				expect(client.getQueryData(notificationKeys.logs(1, { status: "failed" }))).toEqual(failed);
				expect(
					client.getQueryState(notificationKeys.logs(1, { status: "failed" }))?.isInvalidated,
				).toBe(false);
				expect(screen.queryByText("Synthetic filtered failure title")).not.toBeInTheDocument();
			}
			expect(client.getQueryData(notificationKeys.logs(2, selectedFilters))).toEqual(
				vanishedLaterPage,
			);
			expect(client.getQueryState(notificationKeys.logs(2, selectedFilters))?.isInvalidated).toBe(
				false,
			);
			fireEvent.click(screen.getByRole("button", { name: /retry|try again/i }));
			await waitFor(() => expect(selectedReads).toBe(4));
			expect(screen.getByText(knownTitle)).toBeInTheDocument();
			expect(screen.getByRole("status", { busy: true })).toHaveTextContent(
				/last[- ]known.*refresh/i,
			);
			expect(screen.queryByRole("button", { name: /retry|try again/i })).not.toBeInTheDocument();
			await retryPending.finish(
				scope === "combined"
					? combinedRecovered
					: scope === "failed"
						? recoveredFiltered
						: recovered,
			);
			await screen.findByText(
				scope === "combined"
					? "Synthetic combined recovered title"
					: scope === "failed"
						? "Synthetic filtered recovered title"
						: "Synthetic recovered title",
			);
			expect(screen.queryByText(knownTitle)).not.toBeInTheDocument();
			expect(screen.queryByText("Page 1 of 2")).not.toBeInTheDocument();
			expect(screen.queryByRole("alert")).not.toBeInTheDocument();
			expect(screen.queryByRole("status")).not.toBeInTheDocument();
			expect(client.getQueryState(notificationKeys.logs(1, selectedFilters))?.status).toBe(
				"success",
			);
			assertReads(
				requests,
				scope === "combined"
					? [
							firstPath,
							failedPath,
							combinedPath,
							combinedSecondPath,
							combinedPath,
							combinedPath,
							combinedPath,
						]
					: scope === "failed"
						? [firstPath, failedPath, failedSecondPath, failedPath, failedPath, failedPath]
						: [firstPath, secondPath, firstPath, firstPath, firstPath],
			);
		},
	);

	// Catches a count/read race on page one falsely claiming no history exists.
	it.each([false, true])(
		"offers GET-only retry for positive-total empty first page (filtered=%s)",
		async (filtered) => {
			let returnRows = false;
			const requests = transport((path) =>
				json(
					filtered && path === firstPath
						? first
						: returnRows
							? filtered
								? failed
								: first
							: { logs: [], total: 1, page: 1, limit: 15 },
				),
			);
			mount();
			if (filtered) {
				await waitFor(() => expect(screen.getByText("Synthetic sent title")).toBeInTheDocument());
				fireEvent.click(screen.getByRole("button", { name: "Failed" }));
			}
			await waitFor(() => expect(requests).toHaveLength(filtered ? 2 : 1));
			await waitFor(() =>
				expect(screen.queryByRole("status", { busy: true })).not.toBeInTheDocument(),
			);
			expect.soft(screen.queryByText("No notification logs yet")).not.toBeInTheDocument();
			expect.soft(screen.queryByText("No matching logs")).not.toBeInTheDocument();
			expect
				.soft(screen.queryByRole("button", { name: /first page|page 1/i }))
				.not.toBeInTheDocument();
			const retry = screen.queryByRole("button", { name: /retry|try again/i });
			expect.soft(retry).toBeInTheDocument();
			if (retry) {
				returnRows = true;
				fireEvent.click(retry);
				await waitFor(() =>
					expect(
						screen.getByText(
							filtered ? "Synthetic filtered failure title" : "Synthetic sent title",
						),
					).toBeInTheDocument(),
				);
				assertReads(
					requests,
					filtered ? [firstPath, failedPath, failedPath] : [firstPath, firstPath],
				);
			} else {
				assertReads(requests, filtered ? [firstPath, failedPath] : [firstPath]);
			}
		},
	);

	// Catches turning a successful zero-total read into an unknown/error state.
	it("shows confirmed zero-total history as empty without pagination or a retry", async () => {
		const requests = transport(() => json(empty));
		mount();
		await waitFor(() => expect(screen.getByText("No notification logs yet")).toBeInTheDocument());
		expect(screen.queryByRole("table")).not.toBeInTheDocument();
		expect(screen.queryByRole("alert")).not.toBeInTheDocument();
		expect(screen.queryByText(/Page \d+ of/)).not.toBeInTheDocument();
		expect(screen.queryByRole("button", { name: /retry|try again/i })).not.toBeInTheDocument();
		assertReads(requests, [firstPath]);
	});

	// Catches a filtered zero-total state losing its read-only filter reset action.
	it("clears confirmed zero-total filtered history and reads the unfiltered first page", async () => {
		const requests = transport((path) => json(path === failedPath ? empty : first));
		mount();
		await waitFor(() => expect(screen.getByText("Synthetic sent title")).toBeInTheDocument());
		fireEvent.click(screen.getByRole("button", { name: "Failed" }));
		await waitFor(() => expect(screen.getByText("No matching logs")).toBeInTheDocument());
		expect(screen.queryByText("No notification logs yet")).not.toBeInTheDocument();
		fireEvent.click(screen.getByRole("button", { name: "Clear filters" }));
		await waitFor(() => expect(requests).toHaveLength(3));
		expect(screen.getByText("Synthetic sent title")).toBeInTheDocument();
		assertReads(requests, [firstPath, failedPath, firstPath]);
	});

	// Catches rendering synthetic private titles when the real provider enables incognito.
	it("masks titles through the real incognito provider while retaining row status and event", async () => {
		localStorage.setItem("arr-dashboard-incognito-mode", "true");
		const requests = transport(() => json(first));
		mount();
		await waitFor(() => expect(screen.getByRole("table")).toBeInTheDocument());
		expect(screen.queryByText("Synthetic sent title")).not.toBeInTheDocument();
		expect(screen.queryByText("Synthetic failed title")).not.toBeInTheDocument();
		expect(screen.queryByText("Synthetic dead letter title")).not.toBeInTheDocument();
		const rows = within(screen.getByRole("table")).getAllByRole("row");
		expect(rows).toHaveLength(4);
		expect(rows[1]).toHaveTextContent("HUNT_COMPLETED");
		expect(rows[1]).toHaveTextContent("sent");
		for (const row of rows.slice(1)) {
			const title = within(row).getAllByRole("cell")[1]!.textContent;
			expect(title).toBeTruthy();
			expect(title).not.toMatch(/Synthetic/);
		}
		assertReads(requests, [firstPath]);
	});
});
