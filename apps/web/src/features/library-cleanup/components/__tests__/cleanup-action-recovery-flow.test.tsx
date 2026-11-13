import { writeFileSync } from "node:fs";
import { join } from "node:path";
import type {
	CleanupApprovalResponse,
	CleanupConfigResponse,
	CleanupPreviewResponse,
} from "@arr/shared";
import { QueryClient, QueryClientProvider } from "@tanstack/react-query";
import { act, cleanup, fireEvent, render, screen, waitFor, within } from "@testing-library/react";
import { afterAll, afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { IncognitoProvider } from "../../../../contexts/IncognitoContext";
import { libraryCleanupKeys } from "../../../../lib/query-keys";
import { ColorThemeProvider } from "../../../../providers/color-theme-provider";
import { LibraryCleanupClient } from "../library-cleanup-client";

type Request = { url: string; method: string; body: unknown };
const config: CleanupConfigResponse = {
	id: "config",
	enabled: true,
	intervalHours: 24,
	lastRunAt: null,
	nextRunAt: null,
	dryRunMode: false,
	maxRemovalsPerRun: 10,
	requireApproval: false,
	respectQuiSeeding: true,
	rejectionMemoryDays: 30,
	rules: [],
};
const approval = (id: string, status = "pending"): CleanupApprovalResponse => ({
	id,
	instanceId: "source",
	instanceLabel: "Synthetic source",
	arrItemId: id === "a" ? 101 : 102,
	itemType: "movie",
	targetScope: "series",
	arrEpisodeId: null,
	seasonNumber: null,
	episodeNumber: null,
	title: `Synthetic ${id}`,
	matchedRuleId: "rule",
	matchedRuleName: "Synthetic rule",
	reason: "Synthetic reason",
	action: "delete",
	scanMediaServerAfterDelete: false,
	sizeOnDisk: "1073741824",
	year: 2025,
	rating: null,
	status,
	lastExecutionError: null,
	reviewedAt: null,
	executedAt: null,
	createdAt: "2026-10-25T12:00:00Z",
	expiresAt: "2026-11-25T12:00:00Z",
});
const preview: CleanupPreviewResponse = {
	totalEvaluated: 2,
	totalFlagged: 2,
	selectionCountsComplete: true,
	pendingRetryCount: 0,
	items: [
		{
			...approval("a"),
			quiStatus: "no_signal",
			selectionStatus: "selected",
			plannedAction: "delete",
		},
		{
			...approval("b"),
			quiStatus: "seeding",
			selectionStatus: "blocked",
			plannedAction: "unmonitor",
			action: "unmonitor",
		},
	],
	warnings: ["Synthetic cached protection warning"],
	prefetchHealth: { plex: "ok", seerr: "skipped", tautulli: "failed" },
};
const json = (body: unknown, status = 200) =>
	new Response(status === 204 ? null : JSON.stringify(body), {
		status,
		headers: { "content-type": "application/json" },
	});
let requests: Request[];
let rows: CleanupApprovalResponse[];
let configFailure: boolean;
let configGate: ReturnType<typeof deferred> | null;
let approvalFailure: boolean;
let action: (request: Request) => Promise<Response>;
let clients: QueryClient[];
let gates: Array<ReturnType<typeof deferred>>;
let inFlight: Set<Promise<Response>>;
const receipts: unknown[] = [];
function deferred() {
	let release!: () => void;
	const promise = new Promise<void>((resolve) => {
		release = resolve;
	});
	return { promise, release };
}
function hold() {
	const gate = deferred();
	gates.push(gate);
	return gate;
}
const writes = () => requests.filter((request) => request.method !== "GET");
beforeEach(() => {
	localStorage.clear();
	requests = [];
	rows = [approval("a"), approval("b")];
	clients = [];
	gates = [];
	inFlight = new Set();
	configFailure = false;
	configGate = null;
	approvalFailure = false;
	action = async () => json({ removed: 1, failed: 0, errors: [] });
	vi.stubGlobal(
		"fetch",
		vi.fn((url: string, options?: RequestInit) => {
			const request = {
				url,
				method: options?.method ?? "GET",
				body: options?.body ? JSON.parse(String(options.body)) : null,
			};
			requests.push(request);
			const task = (async () => {
				if (request.method !== "GET")
					return url.endsWith("/preview") ? json(preview) : action(request);
				if (url === "/api/library-cleanup/config") {
					if (configGate) await configGate.promise;
					return json(
						configFailure ? { error: "Synthetic config unavailable" } : config,
						configFailure ? 503 : 200,
					);
				}
				if (url === "/api/services") return json({ services: [] });
				if (url.endsWith("/field-options")) return json({});
				if (url.includes("/approval-queue?")) {
					const status = new URL(url, "http://synthetic.invalid").searchParams.get("status");
					const items = rows.filter((row) => row.status === status);
					return json(
						approvalFailure
							? { error: "Synthetic approvals unavailable" }
							: { items, total: items.length, page: 1, pageSize: 20 },
						approvalFailure ? 503 : 200,
					);
				}
				throw new Error(`Unexpected synthetic request ${request.method} ${url}`);
			})();
			inFlight.add(task);
			void task.then(
				() => inFlight.delete(task),
				() => inFlight.delete(task),
			);
			return task;
		}),
	);
});
async function settled() {
	await waitFor(() =>
		expect(
			clients
				.flatMap((client) => client.getMutationCache().getAll())
				.some((mutation) => mutation.state.status === "pending"),
		).toBe(false),
	);
}
afterEach(async () => {
	gates.forEach((gate) => {
		gate.release();
	});
	await act(async () => {
		await Promise.allSettled([...inFlight]);
	});
	await settled();
	receipts.push({
		test: expect.getState().currentTestName,
		requests,
		heldWorkJoined: inFlight.size === 0,
	});
	cleanup();
	clients.forEach((client) => {
		client.clear();
	});
	vi.unstubAllGlobals();
});
afterAll(() => {
	if (process.env.V4_EVIDENCE_ROOT)
		writeFileSync(
			join(process.env.V4_EVIDENCE_ROOT, "cleanup-requests.json"),
			JSON.stringify(receipts, null, 2),
		);
});
function show() {
	const client = new QueryClient({
		defaultOptions: { queries: { retry: false }, mutations: { retry: false } },
	});
	clients.push(client);
	return {
		client,
		...render(
			<QueryClientProvider client={client}>
				<ColorThemeProvider>
					<IncognitoProvider>
						<LibraryCleanupClient />
					</IncognitoProvider>
				</ColorThemeProvider>
			</QueryClientProvider>,
		),
	};
}
async function approvals() {
	const view = show();
	fireEvent.click(await screen.findByRole("button", { name: "Approval Queue" }));
	await screen.findByText("Synthetic a");
	return view;
}
function row(title: string) {
	return screen.getByText(title).closest("div.relative.flex") as HTMLElement;
}

describe("maintained Cleanup actual action and recovery contracts", () => {
	// Catches preview targets being treated as command authority or aggregate partial success being hidden.
	it("C1 previews only, cancels confirmation, then executes normal endpoint once and preserves partial counts", async () => {
		show();
		fireEvent.click(await screen.findByRole("button", { name: "Preview" }));
		await screen.findByText("Synthetic cached protection warning");
		expect(screen.getByText("1 Safety-blocked")).toBeInTheDocument();
		expect(screen.getByText("1 Delete")).toBeInTheDocument();
		expect(writes()).toEqual([{ url: "/api/library-cleanup/preview", method: "POST", body: {} }]);
		fireEvent.click(screen.getByRole("button", { name: "Run Now" }));
		fireEvent.click(within(screen.getByRole("dialog")).getByRole("button", { name: "Cancel" }));
		expect(writes()).toHaveLength(1);
		const gate = hold();
		action = async () => {
			await gate.promise;
			return json({
				isDryRun: false,
				status: "partial",
				itemsEvaluated: 2,
				itemsFlagged: 2,
				itemsRemoved: 1,
				itemsUnmonitored: 0,
				itemsFilesDeleted: 0,
				itemsSkipped: 1,
				durationMs: 5,
				warnings: ["Synthetic execution partial"],
			});
		};
		fireEvent.click(screen.getByRole("button", { name: "Run Now" }));
		fireEvent.click(
			within(screen.getByRole("dialog")).getByRole("button", { name: "Run & Execute" }),
		);
		await waitFor(() => expect(writes()).toHaveLength(2));
		await waitFor(() => expect(screen.getByRole("button", { name: "Run Now" })).toBeDisabled());
		fireEvent.click(screen.getByRole("button", { name: "Run Now" }));
		expect(writes()).toHaveLength(2);
		await act(async () => {
			gate.release();
		});
		await screen.findByText("Status: partial. 2 flagged, 1 removed, 1 skipped");
		await screen.findByText("Synthetic execution partial");
		expect(writes()[1]).toEqual({ url: "/api/library-cleanup/execute", method: "POST", body: {} });
	});
	it("C1 reports execution refusal without automatic destructive replay", async () => {
		action = async () => json({ error: "Synthetic execute refused" }, 503);
		show();
		fireEvent.click(await screen.findByRole("button", { name: "Run Now" }));
		fireEvent.click(
			within(screen.getByRole("dialog")).getByRole("button", { name: "Run & Execute" }),
		);
		await screen.findByText(/Execution failed: Synthetic execute refused/);
		await settled();
		expect(writes()).toEqual([{ url: "/api/library-cleanup/execute", method: "POST", body: {} }]);
		expect(screen.queryByText(/Status: completed/)).not.toBeInTheDocument();
	});

	// Catches replay through failed reads, wrong approval coordinates, and hiding a failed explicit retry.
	it("C2 approves current ID with warning, then explicitly retries only the current failed remainder after GET recovery", async () => {
		rows = [approval("a"), approval("b", "retry_pending")];
		await approvals();
		action = async () => {
			rows = [approval("b", "retry_pending")];
			return json({
				removed: 1,
				failed: 0,
				errors: [],
				warnings: ["Synthetic post-action warning"],
			});
		};
		fireEvent.click(within(row("Synthetic a")).getByRole("button", { name: "Approve" }));
		await screen.findByText("Synthetic post-action warning");
		expect(writes()).toEqual([
			{ url: "/api/library-cleanup/approval-queue/a/approve", method: "POST", body: {} },
		]);
		fireEvent.click(screen.getByRole("button", { name: "Retry pending" }));
		await screen.findByText("Synthetic b");
		action = async () => {
			approvalFailure = true;
			return json({ removed: 0, failed: 1, errors: ["Synthetic remainder refused"] });
		};
		fireEvent.click(screen.getByRole("button", { name: "Resume retry" }));
		await screen.findByText("Synthetic remainder refused");
		await screen.findByText(/Failed to load approval queue/);
		expect(writes()[1]).toEqual({
			url: "/api/library-cleanup/approval-queue/b/retry",
			method: "POST",
			body: {},
		});
		approvalFailure = false;
		fireEvent.click(screen.getByRole("button", { name: "Retry" }));
		await screen.findByRole("button", { name: "Resume retry" });
		expect(writes()).toHaveLength(2);
		action = async () => {
			rows = [];
			return json({ removed: 1, failed: 0, errors: [] });
		};
		fireEvent.click(screen.getByRole("button", { name: "Resume retry" }));
		await screen.findByText("No retry_pending approvals.");
		expect(writes().map((request) => request.url)).toEqual([
			"/api/library-cleanup/approval-queue/a/approve",
			"/api/library-cleanup/approval-queue/b/retry",
			"/api/library-cleanup/approval-queue/b/retry",
		]);
		fireEvent.click(screen.getByRole("button", { name: "Pending" }));
		await screen.findByText("No pending approvals.");
	});

	// Catches omitted reject.error while continuing to exercise the real later success/refetch.
	it("C3 displays rejection refusal and later removes only the explicitly rejected current approval", async () => {
		await approvals();
		action = async () => json({ error: "Synthetic reject refused" }, 503);
		fireEvent.click(within(row("Synthetic a")).getByRole("button", { name: "Reject" }));
		await waitFor(() => expect(writes()).toHaveLength(1));
		await settled();
		expect.soft(screen.queryByRole("alert")).toHaveTextContent("Synthetic reject refused");
		expect(writes()).toHaveLength(1);
		expect(screen.getByText("Synthetic a")).toBeInTheDocument();
		action = async () => {
			rows = [approval("b")];
			return json(null, 204);
		};
		fireEvent.click(within(row("Synthetic a")).getByRole("button", { name: "Reject" }));
		await waitFor(() => expect(screen.queryByText("Synthetic a")).not.toBeInTheDocument());
		expect(screen.getByText("Synthetic b")).toBeInTheDocument();
		expect(writes().map((request) => request.url)).toEqual([
			"/api/library-cleanup/approval-queue/a/reject",
			"/api/library-cleanup/approval-queue/a/reject",
		]);
	});

	it("C4 bulk mixed result uses only selected IDs and retains an actionable failure", async () => {
		await approvals();
		fireEvent.click(screen.getByRole("checkbox", { name: "Select Synthetic a" }));
		fireEvent.click(screen.getByRole("checkbox", { name: "Select Synthetic b" }));
		action = async () => {
			rows = [approval("b", "retry_pending")];
			return json({ removed: 1, failed: 1, errors: ["Synthetic mixed bulk remainder"] });
		};
		fireEvent.click(screen.getByRole("button", { name: "Approve Selected" }));
		await screen.findByText("Synthetic mixed bulk remainder");
		expect(writes()).toEqual([
			{
				url: "/api/library-cleanup/approval-queue/bulk",
				method: "POST",
				body: { ids: ["a", "b"], action: "approved" },
			},
		]);
		fireEvent.click(screen.getByRole("button", { name: "Retry pending" }));
		await screen.findByText("Synthetic b");
		expect(writes()).toHaveLength(1);
	});
	it("C4 does not dispatch selection hidden by a current-row refetch", async () => {
		const view = await approvals();
		fireEvent.click(screen.getByRole("checkbox", { name: "Select Synthetic a" }));
		rows = [approval("b")];
		await act(async () => {
			await view.client.invalidateQueries({ queryKey: libraryCleanupKeys.approvals });
		});
		await waitFor(() => expect(screen.queryByText("Synthetic a")).not.toBeInTheDocument());
		const submit = screen.queryByRole("button", { name: "Approve Selected" });
		if (submit) fireEvent.click(submit);
		await settled();
		expect(writes()).toEqual([]);
	});
	it("C4 a held bulk action prevents an individual overlapping action on the same approval", async () => {
		await approvals();
		const gate = hold();
		action = async () => {
			await gate.promise;
			return json({ removed: 1, failed: 0, errors: [] });
		};
		fireEvent.click(screen.getByRole("checkbox", { name: "Select Synthetic a" }));
		fireEvent.click(screen.getByRole("button", { name: "Approve Selected" }));
		await waitFor(() => expect(writes()).toHaveLength(1));
		fireEvent.click(within(row("Synthetic a")).getByRole("button", { name: "Approve" }));
		await act(async () => {
			await Promise.resolve();
		});
		expect.soft(writes()).toHaveLength(1);
		await act(async () => {
			gate.release();
		});
		await settled();
	});
	it.each(["Approve", "Reject"] as const)(
		"C4 held row %s prevents bulk, other row actions and selection changes until settled",
		async (actionName) => {
			await approvals();
			fireEvent.click(screen.getByRole("checkbox", { name: "Select Synthetic a" }));
			const bulk = screen.getByRole("button", { name: "Approve Selected" });
			const gate = hold();
			action = async () => {
				await gate.promise;
				return json({ removed: 1, failed: 0, errors: [] });
			};
			fireEvent.click(within(row("Synthetic a")).getByRole("button", { name: actionName }));
			await waitFor(() => expect(writes()).toHaveLength(1));
			const other = within(row("Synthetic b")).getByRole("button", { name: "Reject" });
			const select = screen.getByRole("checkbox", { name: "Select Synthetic b" });
			expect.soft(bulk).toBeDisabled();
			expect.soft(other).toBeDisabled();
			expect.soft(select).toBeDisabled();
			expect.soft(screen.getByRole("checkbox", { name: "Select all items" })).toBeDisabled();
			fireEvent.click(bulk);
			fireEvent.click(other);
			fireEvent.click(select);
			await act(async () => {
				await Promise.resolve();
			});
			expect.soft(writes()).toEqual([
				{
					url: `/api/library-cleanup/approval-queue/a/${actionName.toLowerCase()}`,
					method: "POST",
					body: {},
				},
			]);
			await act(async () => {
				gate.release();
			});
			await settled();
			expect(within(row("Synthetic b")).getByRole("button", { name: "Approve" })).toBeEnabled();
		},
	);
	it("C4 changing status filter clears selected current IDs", async () => {
		await approvals();
		fireEvent.click(screen.getByRole("checkbox", { name: "Select Synthetic a" }));
		fireEvent.click(screen.getByRole("button", { name: "Approved" }));
		await screen.findByText("No approved approvals.");
		fireEvent.click(screen.getByRole("button", { name: "Pending" }));
		await screen.findByText("Synthetic a");
		expect(screen.queryByRole("button", { name: "Approve Selected" })).not.toBeInTheDocument();
		expect(writes()).toEqual([]);
	});

	it.each(["cold", "cached"] as const)(
		"C5 reports %s config evidence failure instead of a silent unavailable configuration",
		async (mode) => {
			configFailure = mode === "cold";
			const view = show();
			if (mode === "cached") {
				await screen.findByRole("button", { name: "Preview" });
				configFailure = true;
				await act(async () => {
					await view.client.invalidateQueries({ queryKey: libraryCleanupKeys.config });
				});
			}
			await waitFor(() =>
				expect(view.client.getQueryState(libraryCleanupKeys.config)?.status).toBe("error"),
			);
			expect.soft(screen.queryByRole("alert")).toHaveTextContent(/unavailable|failed|couldn.t/i);
			if (mode === "cached") {
				expect(screen.getByRole("button", { name: "Preview" })).toBeInTheDocument();
				expect.soft(screen.queryByRole("alert")).toHaveTextContent(/last.known|stale/i);
			}
			const retry = screen.queryByRole("button", { name: "Retry" });
			expect.soft(retry).toBeInTheDocument();
			if (!retry) return;
			configFailure = false;
			configGate = hold();
			const readsBefore = requests.filter(
				(request) => request.url === "/api/library-cleanup/config",
			).length;
			fireEvent.click(retry);
			await waitFor(() => expect(retry).toBeDisabled());
			fireEvent.click(retry);
			expect(
				requests.filter((request) => request.url === "/api/library-cleanup/config"),
			).toHaveLength(readsBefore + 1);
			await act(async () => {
				configGate!.release();
			});
			await screen.findByRole("button", { name: "Preview" });
			await waitFor(() => expect(screen.queryByRole("alert")).not.toBeInTheDocument());
			expect(writes()).toEqual([]);
		},
	);
	it("C5 cold approval GET error has a real retry that recovers with GET only", async () => {
		approvalFailure = true;
		show();
		fireEvent.click(await screen.findByRole("button", { name: "Approval Queue" }));
		await screen.findByText(/Failed to load approval queue/);
		expect(screen.queryByText("No pending approvals.")).not.toBeInTheDocument();
		approvalFailure = false;
		fireEvent.click(screen.getByRole("button", { name: "Retry" }));
		await screen.findByText("Synthetic a");
		expect(writes()).toEqual([]);
	});
});
