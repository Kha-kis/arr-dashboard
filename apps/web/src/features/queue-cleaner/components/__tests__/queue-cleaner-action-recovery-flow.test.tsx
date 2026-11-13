import { writeFileSync } from "node:fs";
import { join } from "node:path";
import type { EnhancedPreviewResult } from "@arr/shared";
import { QueryClient, QueryClientProvider } from "@tanstack/react-query";
import { act, cleanup, fireEvent, render, screen, waitFor } from "@testing-library/react";
import { afterAll, afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { Toaster, toast } from "../../../../components/ui/toast";
import { IncognitoProvider } from "../../../../contexts/IncognitoContext";
import { ColorThemeProvider } from "../../../../providers/color-theme-provider";
import type { QueueCleanerLog, QueueCleanerStatus } from "../../lib/queue-cleaner-types";
import { QueueCleanerClient } from "../queue-cleaner-client";

type Request = { url: string; method: string; body: unknown };
const initialStatus: QueueCleanerStatus = {
	schedulerRunning: true,
	schedulerHealthy: true,
	schedulerLastError: null,
	instances: ["source-a", "source-b"].map((instanceId, index) => ({
		instanceId,
		instanceName: "Synthetic duplicate",
		service: "radarr",
		enabled: true,
		dryRunMode: false,
		lastRunAt: null,
		lastRunItemsCleaned: 0,
		lastRunItemsSkipped: 0,
		cleanedToday: index + 1,
		skippedToday: 0,
		hasConfig: true,
	})),
};
const preview: EnhancedPreviewResult = {
	instanceId: "source-b",
	instanceLabel: "Synthetic duplicate",
	instanceService: "radarr",
	instanceReachable: true,
	queueSummary: {
		totalItems: 3,
		downloading: 0,
		paused: 0,
		queued: 0,
		seeding: 0,
		importPending: 2,
		failed: 1,
	},
	wouldRemove: 1,
	wouldImport: 1,
	wouldWarn: 0,
	wouldSkip: 1,
	previewItems: [
		{
			id: 11,
			title: "Synthetic removal",
			action: "remove",
			rule: "failed",
			reason: "Synthetic failure",
			detailedReason: "Synthetic failed download observed",
			queueAge: 60,
		},
		{
			id: 12,
			title: "Synthetic import",
			action: "import",
			rule: "import_pending",
			reason: "Import eligible",
			detailedReason: "Source retained pending current evidence",
			queueAge: 60,
		},
		{
			id: 13,
			title: "Synthetic retained",
			action: "skip",
			rule: "import_pending",
			reason: "Synthetic source retained",
			detailedReason: "Source retained pending current evidence",
			queueAge: 60,
		},
	],
	ruleSummary: { failed: 1, import_pending: 2 },
	previewGeneratedAt: "2026-10-25T12:00:00Z",
	configSnapshot: {
		dryRunMode: false,
		strikeSystemEnabled: false,
		maxStrikes: 2,
		maxRemovalsPerRun: 10,
	},
};
const log: QueueCleanerLog = {
	id: "partial-run",
	instanceId: "source-b",
	instanceName: "Synthetic duplicate",
	service: "radarr",
	itemsCleaned: 0,
	itemsSkipped: 1,
	itemsWarned: 0,
	isDryRun: false,
	cleanedItems: [],
	skippedItems: [
		{
			id: 12,
			title: "Synthetic import",
			rule: "import_pending",
			reason: "Import attempt unknown; source retained",
		},
	],
	warnedItems: [],
	status: "partial",
	message: "Synthetic partial import attempt",
	durationMs: 20,
	startedAt: "2026-10-25T12:00:00Z",
	completedAt: "2026-10-25T12:00:01Z",
};
const json = (body: unknown, status = 200) =>
	new Response(JSON.stringify(body), { status, headers: { "content-type": "application/json" } });
let requests: Request[];
let status: QueueCleanerStatus;
let statusFailure: boolean;
let triggerMode: "success" | "cooldown" | "refused" | "lost";
let triggerGate: ReturnType<typeof deferred> | null;
let clients: QueryClient[];
let active: Set<Promise<Response>>;
const receipts: unknown[] = [];
function deferred() {
	let release!: () => void;
	const promise = new Promise<void>((resolve) => {
		release = resolve;
	});
	return { promise, release };
}
const writes = () => requests.filter((request) => request.method !== "GET");
const triggers = () => writes().filter((request) => request.url.includes("/trigger/"));
beforeEach(() => {
	localStorage.clear();
	requests = [];
	clients = [];
	active = new Set();
	status = structuredClone(initialStatus);
	statusFailure = false;
	triggerMode = "success";
	triggerGate = null;
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
				if (url === "/api/queue-cleaner/status")
					return json(
						statusFailure ? { error: "Synthetic status unavailable" } : status,
						statusFailure ? 503 : 200,
					);
				if (url.startsWith("/api/queue-cleaner/logs?")) return json({ logs: [log], totalCount: 1 });
				if (url === "/api/queue-cleaner/preview/source-b") return json(preview);
				if (url === "/api/queue-cleaner/trigger/source-b") {
					if (triggerGate) await triggerGate.promise;
					if (triggerMode === "lost") throw new TypeError("Synthetic lost trigger acknowledgement");
					if (triggerMode === "cooldown") return json({ error: "Synthetic cooldown active" }, 429);
					if (triggerMode === "refused") return json({ error: "Synthetic trigger refused" }, 503);
					return json({ triggered: true, message: "Queue clean started" }, 202);
				}
				throw new Error(`Unexpected synthetic request ${request.method} ${url}`);
			})();
			active.add(task);
			void task.then(
				() => active.delete(task),
				() => active.delete(task),
			);
			return task;
		}),
	);
});
afterEach(async () => {
	triggerGate?.release();
	await act(async () => {
		await Promise.allSettled([...active]);
	});
	await waitFor(() =>
		expect(
			clients
				.flatMap((client) => client.getMutationCache().getAll())
				.some((mutation) => mutation.state.status === "pending"),
		).toBe(false),
	);
	receipts.push({
		test: expect.getState().currentTestName,
		requests,
		heldWorkJoined: active.size === 0,
	});
	toast.dismiss();
	cleanup();
	clients.forEach((client) => {
		client.clear();
	});
	vi.unstubAllGlobals();
});
afterAll(() => {
	if (process.env.V4_EVIDENCE_ROOT)
		writeFileSync(
			join(process.env.V4_EVIDENCE_ROOT, "queue-cleaner-action-requests.json"),
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
						<QueueCleanerClient />
						<Toaster />
					</IncognitoProvider>
				</ColorThemeProvider>
			</QueryClientProvider>,
		),
	};
}
async function chosen(name: "Preview" | "Run Now") {
	const buttons = await screen.findAllByRole("button", { name });
	expect(buttons).toHaveLength(2);
	return buttons[1]!;
}

describe("maintained Queue Cleaner action and current readback", () => {
	// Catches same-name source selection errors and use of preview item IDs as trigger authority.
	it("K1 preview chooses the exact source and keeps conditional import/removal/retention distinct before ordinary trigger", async () => {
		show();
		fireEvent.click(await chosen("Preview"));
		await screen.findByRole("button", { name: /Would Attempt Import \(1\)/ });
		expect(screen.getByRole("button", { name: /Would Remove \(1\)/ })).toBeInTheDocument();
		expect(screen.getByRole("button", { name: /Would Keep \(1\)/ })).toBeInTheDocument();
		expect(writes()).toEqual([
			{ url: "/api/queue-cleaner/preview/source-b", method: "POST", body: {} },
		]);
		fireEvent.click(screen.getByRole("button", { name: "Close" }));
		expect(triggers()).toEqual([]);
		fireEvent.click(await chosen("Preview"));
		fireEvent.click(await screen.findByRole("button", { name: "Run Clean Now" }));
		await screen.findByText("Queue clean started");
		expect(triggers()).toEqual([
			{ url: "/api/queue-cleaner/trigger/source-b", method: "POST", body: {} },
		]);
		expect(screen.queryByText("Queue clean completed")).not.toBeInTheDocument();
	});

	it("K2 held direct admission blocks duplicate direct trigger and reports started rather than completed", async () => {
		show();
		triggerGate = deferred();
		const button = await chosen("Run Now");
		fireEvent.click(button);
		await waitFor(() => expect(triggers()).toHaveLength(1));
		await waitFor(() => expect(button).toBeDisabled());
		fireEvent.click(button);
		expect(triggers()).toHaveLength(1);
		await act(async () => {
			triggerGate!.release();
		});
		await screen.findByText("Queue clean started");
		await waitFor(() =>
			expect(requests.filter((request) => request.url.endsWith("/status")).length).toBeGreaterThan(
				1,
			),
		);
		expect(screen.getByText("3")).toBeInTheDocument();
		expect(triggers()).toHaveLength(1);
	});

	// Both controls are reachable: Preview remains available while the direct trigger is held.
	it("K2 held direct trigger prevents a second same-target preview-mediated trigger", async () => {
		show();
		triggerGate = deferred();
		fireEvent.click(await chosen("Run Now"));
		await waitFor(() => expect(triggers()).toHaveLength(1));
		fireEvent.click(await chosen("Preview"));
		const button = await screen.findByRole("button", { name: "Run Clean Now" });
		fireEvent.click(button);
		await act(async () => {
			await Promise.resolve();
		});
		expect.soft(triggers()).toHaveLength(1);
		await act(async () => {
			triggerGate!.release();
		});
		await screen.findAllByText("Queue clean started");
	});

	it("K2 held preview-mediated trigger prevents a direct same-target trigger until settled", async () => {
		show();
		triggerGate = deferred();
		const direct = await chosen("Run Now");
		fireEvent.click(await chosen("Preview"));
		const modalRun = await screen.findByRole("button", { name: "Run Clean Now" });
		fireEvent.click(modalRun);
		await waitFor(() => expect(triggers()).toHaveLength(1));
		expect.soft(direct).toBeDisabled();
		expect(modalRun).toBeDisabled();
		fireEvent.click(direct);
		await act(async () => {
			await Promise.resolve();
		});
		expect
			.soft(triggers())
			.toEqual([{ url: "/api/queue-cleaner/trigger/source-b", method: "POST", body: {} }]);
		await act(async () => {
			triggerGate!.release();
		});
		await screen.findAllByText("Queue clean started");
		await waitFor(() => expect(direct).toBeEnabled());
	});

	it.each([
		{ entry: "direct", mode: "cooldown" },
		{ entry: "preview", mode: "refused" },
		{ entry: "preview", mode: "lost" },
	] as const)(
		"K2 $entry $mode remains an actionable failure and current GET never replays admission",
		async ({ entry, mode }) => {
			show();
			triggerMode = mode;
			if (entry === "preview") {
				fireEvent.click(await chosen("Preview"));
				fireEvent.click(await screen.findByRole("button", { name: "Run Clean Now" }));
			} else fireEvent.click(await chosen("Run Now"));
			await screen.findByText(
				entry === "direct" ? "Synthetic cooldown active" : "Failed to start clean",
			);
			expect(triggers()).toHaveLength(1);
			expect(screen.queryByText("Queue clean started")).not.toBeInTheDocument();
			if (entry === "preview") fireEvent.click(screen.getByRole("button", { name: "Close" }));
			fireEvent.click(screen.getByRole("button", { name: "Refresh" }));
			await waitFor(() =>
				expect(
					requests.filter((request) => request.url.endsWith("/status")).length,
				).toBeGreaterThan(1),
			);
			expect(triggers()).toHaveLength(1);
		},
	);

	it("K3 cold status error stays unavailable and re-entry recovers with GET only", async () => {
		statusFailure = true;
		const view = show();
		await screen.findByText(/Failed to load queue cleaner status/);
		expect(screen.queryByText("No instances available")).not.toBeInTheDocument();
		view.unmount();
		view.client.clear();
		statusFailure = false;
		show();
		await chosen("Preview");
		expect(writes()).toEqual([]);
	});
	it("K3 cached failed refresh retains last-known values with stale disclosure, then current GET recovers", async () => {
		show();
		await chosen("Preview");
		expect(screen.getByText("3")).toBeInTheDocument();
		statusFailure = true;
		fireEvent.click(screen.getByRole("button", { name: "Refresh" }));
		await screen.findByText(/Couldn't refresh/);
		expect(screen.getByText("3")).toBeInTheDocument();
		statusFailure = false;
		status = {
			...status,
			instances: status.instances.map((instance) => ({ ...instance, cleanedToday: 9 })),
		};
		await waitFor(() => expect(screen.getByRole("button", { name: "Refresh" })).toBeEnabled());
		fireEvent.click(screen.getByRole("button", { name: "Refresh" }));
		await screen.findByText("18");
		expect(writes()).toEqual([]);
	});

	it("K4 Activity queries actual partial/import-attempt readback without relabeling the retained source as removed", async () => {
		show();
		await chosen("Preview");
		fireEvent.click(screen.getByRole("button", { name: "Activity" }));
		const entry = await screen.findByRole("button", { name: /Synthetic partial import attempt/ });
		fireEvent.click(entry);
		await screen.findByText("Import attempt unknown; source retained");
		expect(screen.getByText("partial", { exact: true })).toBeInTheDocument();
		expect(screen.queryByText(/Removed \(1\)/)).not.toBeInTheDocument();
		fireEvent.change(screen.getByRole("combobox"), { target: { value: "partial" } });
		await waitFor(() =>
			expect(
				requests.some(
					(request) => request.url === "/api/queue-cleaner/logs?status=partial&page=1&pageSize=20",
				),
			).toBe(true),
		);
		expect(writes()).toEqual([]);
	});
});
