import type { QuiActionLogEntry, QuiActivityEvent, ServiceInstanceSummary } from "@arr/shared";
import { QueryClient, QueryClientProvider } from "@tanstack/react-query";
import { act, cleanup, fireEvent, render, screen, waitFor, within } from "@testing-library/react";
import { afterEach, describe, expect, it, vi } from "vitest";
import { IncognitoProvider } from "../../../../contexts/IncognitoContext";
import { getLinuxInstanceName } from "../../../../lib/incognito";
import { ColorThemeProvider } from "../../../../providers/color-theme-provider";
import { QuiActivityClient } from "../qui-activity-client";

// Framework boundary only: the component, hooks, query cache and API clients are real.
vi.mock("next/navigation", () => ({ usePathname: () => "/qui/activity" }));

const HASH = "0123456789abcdef0123456789abcdef01234567";
const SHORT_HASH = "01234567…01234567";
const TIME = "2026-01-01T00:00:00.000Z";
const STATUSES = [
	"pending",
	"success",
	"failed",
	"uncertain",
	"operator_verified_applied",
	"operator_verified_not_applied",
] as const;
const service: ServiceInstanceSummary = {
	id: "synthetic-qui",
	service: "qui",
	label: "Synthetic Receiver",
	baseUrl: "https://qui.synthetic.invalid",
	externalUrl: null,
	enabled: true,
	isDefault: false,
	hasApiKey: true,
	storageGroupId: null,
	hasLocalFilesystemAccess: false,
	pathPrefix: null,
	tags: [],
	createdAt: TIME,
	updatedAt: TIME,
	identity: {
		status: "unverified",
		kind: null,
		fingerprint: null,
		verifiedAt: null,
		lastCheckedAt: null,
	},
};
const event = (id: string, eventType = id): QuiActivityEvent => ({
	id,
	eventType,
	severity: "ok",
	status: "ok",
	createdAt: TIME,
	timestamp: TIME,
	details: null,
});
const action = (
	id: string,
	status: QuiActionLogEntry["status"] = "success",
): QuiActionLogEntry => ({
	id,
	serviceInstanceId: service.id,
	serviceInstanceLabel: service.label,
	qbitInstanceId: 7,
	torrentHash: HASH,
	action: "pause",
	status,
	error: null,
	payload: null,
	requestedAt: TIME,
	timestamp: TIME,
	completedAt: status === "pending" ? null : TIME,
});
const json = (body: unknown, status = 200) =>
	new Response(JSON.stringify(body), { status, headers: { "content-type": "application/json" } });
const unavailable = () => json({ message: "Synthetic read unavailable" }, 503);
const clients: QueryClient[] = [];
const violations: string[] = [];
afterEach(() => {
	cleanup();
	for (const client of clients.splice(0)) client.clear();
	vi.restoreAllMocks();
	vi.unstubAllGlobals();
	localStorage.clear();
	expect(violations.splice(0)).toEqual([]);
});
function transport(
	path: "activity" | "actions",
	handler: (url: URL) => Response | Promise<Response>,
) {
	const calls: string[] = [];
	vi.stubGlobal("fetch", async (input: string, init?: RequestInit) => {
		const url = new URL(String(input), "https://synthetic.invalid");
		if (
			url.origin !== "https://synthetic.invalid" ||
			init?.method !== "GET" ||
			!["/api/services", "/api/qui/activity", "/api/qui/" + path].includes(url.pathname)
		) {
			violations.push((init?.method ?? "unknown") + " " + url.pathname);
			throw Error("Unexpected synthetic read");
		}
		calls.push(url.pathname + url.search);
		if (url.pathname === "/api/services") return json({ services: [service] });
		if (url.pathname !== "/api/qui/" + path) return json({ events: [], nextCursor: null });
		return handler(url);
	});
	return () => calls.filter((call) => call.startsWith("/api/qui/" + path));
}
async function mount(tab: "Activity feed" | "My Actions" = "Activity feed") {
	const client = new QueryClient({
		defaultOptions: { queries: { retry: false, gcTime: Infinity, refetchOnWindowFocus: false } },
	});
	clients.push(client);
	render(
		<QueryClientProvider client={client}>
			<ColorThemeProvider>
				<IncognitoProvider>
					<QuiActivityClient />
				</IncognitoProvider>
			</ColorThemeProvider>
		</QueryClientProvider>,
	);
	fireEvent.click(await screen.findByRole("tab", { name: tab }));
}
function deferred() {
	let resolve!: (value: Response) => void;
	return {
		promise: new Promise<Response>((done) => {
			resolve = done;
		}),
		resolve: (value: Response) => resolve(value),
	};
}
const refresh = () => screen.getByRole("button", { name: "Refresh" });
const expectSelected = (tab: string) =>
	expect(screen.getByRole("tab", { name: tab })).toHaveAttribute("aria-selected", "true");
function expectReconciliationBlocked() {
	for (const name of ["Verified applied", "Verified not applied"]) {
		for (const button of screen.queryAllByRole("button", { name })) {
			expect(button).toBeDisabled();
			fireEvent.click(button);
		}
	}
}

describe("qUI log reads through real hooks and HTTP clients", () => {
	it("keeps scheduler filters and cursor paging as exact GET reads, never sync/backfill commands", async () => {
		const reads = transport("activity", (url) => {
			const type = url.searchParams.get("eventType");
			return json({
				events: [
					event(
						url.searchParams.has("cursor") ? "older row" : "latest row",
						type ?? (url.searchParams.has("cursor") ? "older row" : "latest row"),
					),
				],
				nextCursor: type || url.searchParams.has("cursor") ? null : "older cursor",
			});
		});
		await mount();
		await screen.findByText("latest row");
		fireEvent.click(screen.getByRole("button", { name: "Load older events" }));
		await screen.findByText("older row");
		expect(screen.getByText("latest row")).toBeInTheDocument();
		fireEvent.click(screen.getByRole("button", { name: "Torrent-state sync" }));
		await screen.findByText("Torrent-state sync completed");
		fireEvent.click(screen.getByRole("button", { name: "InfoHash backfill" }));
		await screen.findByText("InfoHash backfill tick");
		fireEvent.click(screen.getByRole("button", { name: "All events" }));
		await screen.findByText("older row");
		expect(reads()).toEqual([
			"/api/qui/activity?limit=50",
			"/api/qui/activity?cursor=older+cursor&limit=50",
			"/api/qui/activity?limit=50&eventType=qui_sync_complete",
			"/api/qui/activity?limit=50&eventType=qui_backfill_complete",
		]);
	});

	it.each(["activity", "actions"] as const)(
		"does not call a cold %s failure empty and prevents duplicate GET recovery clicks",
		async (path) => {
			const activity = path === "activity";
			const empty = activity ? "No qui activity yet" : "No torrent actions yet";
			const rows = activity ? "events" : "entries";
			const pending = deferred();
			let phase: "failed" | "empty" | "pending" = "failed";
			const reads = transport(path, () =>
				phase === "failed"
					? unavailable()
					: phase === "empty"
						? json({ [rows]: [], nextCursor: null })
						: pending.promise,
			);
			await mount(activity ? "Activity feed" : "My Actions");
			expect(await screen.findByRole("alert")).toHaveTextContent(
				activity ? /Failed to load activity/ : /Failed to load action log/,
			);
			expect(screen.queryByText(empty)).not.toBeInTheDocument();
			phase = "empty";
			fireEvent.click(refresh());
			await screen.findByText(empty);
			phase = "pending";
			fireEvent.click(refresh());
			await waitFor(() => expect(refresh()).toBeDisabled());
			fireEvent.click(refresh());
			expect(reads()).toEqual(Array(3).fill("/api/qui/" + path + "?limit=50"));
			await act(async () =>
				pending.resolve(
					json({
						[rows]: [activity ? event("recovered row") : action("recovered", "uncertain")],
						nextCursor: null,
					}),
				),
			);
			await screen.findByText(activity ? "recovered row" : /Outcome not confirmed/);
			expect(screen.queryByRole("alert")).not.toBeInTheDocument();
			expect(refresh()).toBeEnabled();
		},
	);

	it("retains every Activity page after later-page and Refresh failures and rebuilds fresh cursors", async () => {
		let phase: "initial" | "failed" | "recovered" = "initial";
		const reads = transport("activity", (url) => {
			const cursor = url.searchParams.get("cursor");
			if (phase === "failed" || cursor === "expired cursor") return unavailable();
			return json({
				events: [
					event(
						cursor
							? phase === "initial"
								? "known older"
								: "fresh older"
							: phase === "initial"
								? "known latest"
								: "fresh latest",
					),
				],
				nextCursor: cursor
					? phase === "initial"
						? "expired cursor"
						: null
					: phase === "initial"
						? "old cursor"
						: "fresh cursor",
			});
		});
		await mount();
		fireEvent.click(await screen.findByRole("button", { name: "Load older events" }));
		await screen.findByText("known older");
		fireEvent.click(screen.getByRole("button", { name: "Load older events" }));
		await screen.findByRole("alert");
		expect.soft(screen.queryByText("known latest")).toBeInTheDocument();
		expect.soft(screen.queryByText("known older")).toBeInTheDocument();
		expect.soft(screen.getByRole("alert")).toHaveTextContent(/last-known/i);
		phase = "failed";
		fireEvent.click(refresh());
		await waitFor(() => expect(refresh()).toBeEnabled());
		expect.soft(screen.queryByText("known latest")).toBeInTheDocument();
		expect.soft(screen.queryByText("known older")).toBeInTheDocument();
		phase = "recovered";
		fireEvent.click(refresh());
		await screen.findByText("fresh older");
		expect(screen.getByText("fresh latest")).toBeInTheDocument();
		expectSelected("Activity feed");
		expect(screen.queryByRole("alert")).not.toBeInTheDocument();
		expect(reads()).toEqual([
			"/api/qui/activity?limit=50",
			"/api/qui/activity?cursor=old+cursor&limit=50",
			"/api/qui/activity?cursor=expired+cursor&limit=50",
			"/api/qui/activity?limit=50",
			"/api/qui/activity?limit=50",
			"/api/qui/activity?cursor=fresh+cursor&limit=50",
		]);
	});

	it("filters exact action/status GETs while preserving safe audit and local hash disclosure in incognito", async () => {
		localStorage.setItem("arr-dashboard-incognito-mode", "true");
		const reads = transport("actions", (url) => {
			const status = url.searchParams.get("status") as QuiActionLogEntry["status"] | null;
			const entries = status
				? [action(status, status)]
				: [
						action("held", "uncertain"),
						{ ...action("tracker"), action: "addTrackers", payload: { trackerCount: 2 } },
						{ ...action("failed", "failed"), error: "Synthetic action rejected" },
						action("applied", "operator_verified_applied"),
						action("not-applied", "operator_verified_not_applied"),
					];
			return json({ entries, nextCursor: null });
		});
		await mount("My Actions");
		await screen.findByText(/Outcome not confirmed/);
		expect(screen.queryByText(service.label)).not.toBeInTheDocument();
		expect(screen.getAllByText(getLinuxInstanceName(service.label))).toHaveLength(5);
		expect(screen.getByText(/2 trackers/)).toBeInTheDocument();
		expect(screen.getByText(/Exact names and announce URLs are not retained/)).toBeInTheDocument();
		expect(screen.getByText("Synthetic action rejected")).toBeInTheDocument();
		expect(screen.getAllByText(/Operator-verified outcome; qUI did not confirm/)).toHaveLength(2);
		const beforeDisclosure = reads();
		fireEvent.click(screen.getByRole("button", { name: "Show full info hash for verification" }));
		expect(screen.getByText(HASH)).toBeInTheDocument();
		fireEvent.click(screen.getByRole("button", { name: "Hide full info hash" }));
		expect(screen.queryByText(HASH)).not.toBeInTheDocument();
		expect(screen.getAllByText(SHORT_HASH)).toHaveLength(5);
		expect(reads()).toEqual(beforeDisclosure);
		fireEvent.change(screen.getByRole("combobox", { name: "Filter by action" }), {
			target: { value: "pause" },
		});
		await waitFor(() => expect(reads()).toHaveLength(2));
		for (const status of STATUSES) {
			fireEvent.change(await screen.findByRole("combobox", { name: "Filter by status" }), {
				target: { value: status },
			});
			await waitFor(() =>
				expect(reads().at(-1)).toBe("/api/qui/actions?limit=50&action=pause&status=" + status),
			);
			await waitFor(() => {
				expect(screen.getAllByRole("listitem")).toHaveLength(1);
				const row = within(screen.getByRole("listitem"));
				if (status === "pending" || status === "uncertain")
					expect(row.getByText(/Outcome not confirmed/)).toBeInTheDocument();
				else expect(row.queryByText(/Outcome not confirmed/)).not.toBeInTheDocument();
				if (status.startsWith("operator_verified"))
					expect(row.getByText(/qUI did not confirm/)).toBeInTheDocument();
			});
		}
		expect(reads()).toEqual([
			"/api/qui/actions?limit=50",
			"/api/qui/actions?limit=50&action=pause",
			...STATUSES.map((status) => "/api/qui/actions?limit=50&action=pause&status=" + status),
		]);
	});

	it("retains paged actions on later-read and Refresh failure, then restarts selected tab with fresh cursors", async () => {
		const pending = deferred();
		let phase: "initial" | "failed" | "recovering" | "recovered" = "initial";
		const reads = transport("actions", (url) => {
			const cursor = url.searchParams.get("cursor");
			if (phase === "recovering") return pending.promise;
			if (phase === "failed" || cursor === "expired cursor") return unavailable();
			const entry = action(cursor ? "older" : "latest", cursor ? "failed" : "uncertain");
			entry.error = cursor
				? phase === "initial"
					? "Known older action"
					: "Fresh older action"
				: null;
			return json({
				entries: [entry],
				nextCursor: cursor
					? phase === "initial"
						? "expired cursor"
						: null
					: phase === "initial"
						? "old cursor"
						: "fresh cursor",
			});
		});
		await mount("My Actions");
		fireEvent.click(await screen.findByRole("button", { name: "Load older actions" }));
		await screen.findByText("Known older action");
		fireEvent.click(screen.getByRole("button", { name: "Load older actions" }));
		await screen.findByRole("alert");
		expectReconciliationBlocked();
		expect.soft(screen.queryByText("Known older action")).toBeInTheDocument();
		expect.soft(screen.queryByText(/Outcome not confirmed/)).toBeInTheDocument();
		expect.soft(screen.getByRole("alert")).toHaveTextContent(/last-known/i);
		phase = "failed";
		fireEvent.click(refresh());
		await waitFor(() => expect(refresh()).toBeEnabled());
		expectReconciliationBlocked();
		expect.soft(screen.queryByText("Known older action")).toBeInTheDocument();
		expect.soft(screen.queryByText(/Outcome not confirmed/)).toBeInTheDocument();
		phase = "recovering";
		fireEvent.click(refresh());
		await waitFor(() => expect(refresh()).toBeDisabled());
		expectReconciliationBlocked();
		expect.soft(screen.queryByText("Known older action")).toBeInTheDocument();
		expect.soft(screen.queryByText(/Outcome not confirmed/)).toBeInTheDocument();
		await act(async () => {
			phase = "recovered";
			pending.resolve(
				json({ entries: [action("latest", "uncertain")], nextCursor: "fresh cursor" }),
			);
		});
		await screen.findByText("Fresh older action");
		expect(screen.getByText(/Outcome not confirmed/)).toBeInTheDocument();
		expectSelected("My Actions");
		expect(screen.getByRole("button", { name: "Verified applied" })).toBeEnabled();
		expect(screen.getByRole("button", { name: "Verified not applied" })).toBeEnabled();
		expect(screen.queryByRole("alert")).not.toBeInTheDocument();
		expect(reads()).toEqual([
			"/api/qui/actions?limit=50",
			"/api/qui/actions?cursor=old+cursor&limit=50",
			"/api/qui/actions?cursor=expired+cursor&limit=50",
			"/api/qui/actions?limit=50",
			"/api/qui/actions?limit=50",
			"/api/qui/actions?cursor=fresh+cursor&limit=50",
		]);
	});
});
