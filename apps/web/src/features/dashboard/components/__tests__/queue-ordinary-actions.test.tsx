import "@testing-library/jest-dom/vitest";
import type { MultiInstanceQueueResponse, QueueItem } from "@arr/shared";
import { QueryClient, QueryClientProvider } from "@tanstack/react-query";
import { act, cleanup, fireEvent, render, screen, waitFor } from "@testing-library/react";
import { afterEach, describe, expect, it, vi } from "vitest";
import { IncognitoProvider } from "../../../../contexts/IncognitoContext";
import { authKeys, QUEUE_QUERY_KEY } from "../../../../lib/query-keys";
import { ColorThemeProvider } from "../../../../providers/color-theme-provider";
import { useQueueGrouping } from "../../hooks/use-queue-grouping";
import { useDashboardQueue } from "../../hooks/useDashboardQueue";
import { DashboardClient } from "../dashboard-client";
import { QueueTable } from "../queue-table";

// Only unrelated framework/widgets/account-service/statistics data are replaced.
// The queue query, action hook/client, grouping/selection, cards, menus and actual
// Dashboard error Alert remain maintained implementations.
vi.mock("next/navigation", () => ({ useRouter: () => ({ push: vi.fn() }) }));
vi.mock("../../../../hooks/api/useDashboard", async (importOriginal) => ({
	...(await importOriginal<typeof import("../../../../hooks/api/useDashboard")>()),
	useDashboardStatisticsQuery: () => ({}),
}));
vi.mock("../../hooks/useDashboardData", async () => {
	const { useMultiInstanceQueueQuery } = await import("../../../../hooks/api/useDashboard");
	return {
		useDashboardData: () => {
			const query = useMultiInstanceQueueQuery();
			return {
				currentUser: { id: "owner", username: "Synthetic" },
				services: [],
				enabledServices: [],
				servicesRefetch: () => {},
				groupedByService: {},
				queueAggregated: query.data?.aggregated ?? [],
				queueInstances: query.data?.instances ?? [],
				totalQueueItems: query.data?.totalCount ?? 0,
				queueLoading: query.isLoading,
				queueRefetch: query.refetch,
				instanceOptions: [],
				statusOptions: [],
				isLoading: query.isLoading,
			};
		},
	};
});
vi.mock("../needs-attention-panel", () => ({ NeedsAttentionPanel: () => null }));
vi.mock("../on-deck-widget", () => ({ OnDeckWidget: () => null }));
vi.mock("../recently-added-widget", () => ({ RecentlyAddedWidget: () => null }));
vi.mock("../seerr-requests-widget", () => ({ SeerrRequestsWidget: () => null }));
vi.mock("../watch-history-section", () => ({ WatchHistorySection: () => null }));
const row = (instanceId: string, id = 11, extra = {}): QueueItem => ({
	instanceId,
	id,
	instanceName: "Synthetic",
	title: `Synthetic ${instanceId} ${id}`,
	service: "radarr",
	actions: { canRetry: true, canRemove: true },
	...extra,
});
const queue = (rows: QueueItem[]): MultiInstanceQueueResponse => ({
	instances: rows.map((value) => ({
		instanceId: value.instanceId,
		instanceName: value.instanceName,
		service: value.service,
		data: [value],
	})),
	aggregated: rows,
	totalCount: rows.length,
});
function Controls({ rows }: { rows: QueueItem[] }) {
	const actions = useDashboardQueue(),
		summaryRows = useQueueGrouping(rows);
	return (
		<QueueTable
			items={rows}
			summaryRows={summaryRows}
			pending={actions.queueActionsPending}
			onRetry={actions.handleQueueRetry}
			onRemove={actions.handleQueueRemove}
			onChangeCategory={actions.handleQueueChangeCategory}
		/>
	);
}
const clients: QueryClient[] = [];
function mount(rows: QueueItem[], dashboard = false) {
	const client = new QueryClient({
		defaultOptions: {
			mutations: { retry: false, gcTime: Infinity },
			queries: { retry: false, gcTime: Infinity, staleTime: Infinity },
		},
	});
	clients.push(client);
	client.setQueryData(authKeys.currentUser, { id: "owner", username: "Synthetic" });
	client.setQueryData(QUEUE_QUERY_KEY, queue(rows));
	render(
		<QueryClientProvider client={client}>
			<ColorThemeProvider>
				<IncognitoProvider>
					{dashboard ? <DashboardClient /> : <Controls rows={rows} />}
				</IncognitoProvider>
			</ColorThemeProvider>
		</QueryClientProvider>,
	);
	return client;
}
function selectRemoval(label: string, trigger = screen.getByRole("button", { name: "Remove" })) {
	fireEvent.keyDown(trigger, { key: "ArrowDown", code: "ArrowDown" });
	fireEvent.click(screen.getByText(label, { exact: true }));
}
afterEach(() => {
	cleanup();
	for (const client of clients.splice(0)) client.clear();
	vi.unstubAllGlobals();
	sessionStorage.clear();
	localStorage.clear();
});
describe("maintained ordinary queue UI controls", () => {
	it.each(["single", "group", "selection"])(
		"Q6 %s retry selects only eligible exact targets and blocks duplicate pending clicks",
		async (mode) => {
			const first = row("first"),
				second = row(mode === "selection" ? "second" : "first", mode === "selection" ? 11 : 12, {
					actions: { canRetry: false, canRemove: true },
					...(mode === "group" ? { downloadId: "synthetic-shared" } : {}),
				});
			if (mode === "group") first.downloadId = "synthetic-shared";
			const rows = mode === "single" ? [first] : [first, second],
				requests: unknown[] = [];
			let release!: () => void;
			const held = new Promise<void>((resolve) => {
				release = resolve;
			});
			const running = new Set<Promise<Response>>();
			vi.stubGlobal("fetch", async (_url: string, options?: RequestInit) => {
				const response = (async () => {
					requests.push(JSON.parse(String(options?.body)));
					await held;
					return new Response(null, { status: 204 });
				})();
				running.add(response);
				try {
					return await response;
				} finally {
					running.delete(response);
				}
			});
			mount(rows);
			try {
				if (mode === "selection")
					for (const checkbox of screen.getAllByRole("checkbox")) fireEvent.click(checkbox);
				const button = screen.getAllByRole("button", { name: "Retry" })[0]!;
				fireEvent.click(button);
				await waitFor(() => expect(requests).toHaveLength(1));
				await waitFor(() => expect(button).toBeDisabled());
				fireEvent.click(button);
				expect(requests).toEqual([
					{
						instanceId: "first",
						service: "radarr",
						itemId: 11,
						action: "retry",
						removeFromClient: true,
						blocklist: false,
						changeCategory: false,
						search: false,
					},
				]);
				expect(
					screen.getAllByRole("checkbox").every((value) => (value as HTMLInputElement).disabled),
				).toBe(true);
				for (const value of screen.getAllByRole("button", { name: "Remove" }))
					expect(value).toBeDisabled();
			} finally {
				await act(async () => {
					release();
					await Promise.allSettled([...running]);
				});
				await waitFor(() =>
					expect(screen.getAllByRole("button", { name: "Retry" })[0]).not.toBeDisabled(),
				);
				expect(running.size).toBe(0);
			}
		},
	);
	it.each([
		["Remove (keep in download client)", false, false],
		["Remove & delete from download client", true, false],
		["Blocklist release", false, true],
		["Blocklist & delete download", true, true],
	] as const)(
		"Q6 removal menu forwards literal flags: %s",
		async (label, removeFromClient, blocklist) => {
			const requests: unknown[] = [];
			vi.stubGlobal("fetch", async (_url: string, options?: RequestInit) => {
				requests.push(JSON.parse(String(options?.body)));
				return new Response(null, { status: 204 });
			});
			mount([row("first")]);
			selectRemoval(label);
			await waitFor(() => expect(requests).toHaveLength(1));
			await waitFor(() =>
				expect(screen.getByRole("button", { name: "Remove" })).not.toBeDisabled(),
			);
			expect(requests).toEqual([
				{
					instanceId: "first",
					service: "radarr",
					itemId: 11,
					action: "delete",
					removeFromClient,
					blocklist,
					changeCategory: false,
					search: false,
				},
			]);
		},
	);
	it.each(["row", "selected-toolbar"])(
		"Q2 actual Dashboard %s refusal shows its existing Alert/row, releases pending and permits explicit remaining-target retry",
		async (mode) => {
			const selected = row("first"),
				posts: unknown[] = [];
			let accepted = false,
				reads = 0;
			vi.stubGlobal("fetch", async (url: string, options?: RequestInit) => {
				if (url === "/auth/me") return Response.json({ id: "owner", username: "Synthetic" });
				if (!options?.body) {
					reads++;
					return Response.json(queue(accepted ? [] : [selected]));
				}
				posts.push(JSON.parse(String(options.body)));
				return accepted
					? new Response(null, { status: 204 })
					: Response.json({ message: "Synthetic removal refused" }, { status: 500 });
			});
			mount([selected], true);
			fireEvent.click(screen.getByRole("tab", { name: "Active Queue" }));
			if (mode === "selected-toolbar") fireEvent.click(screen.getByRole("checkbox"));
			selectRemoval(
				"Remove (keep in download client)",
				screen.getAllByRole("button", { name: "Remove" })[0],
			);
			// This is intentionally the real negative UI click. Any discarded async
			// rejection is application evidence retained by the isolated Vitest run.
			await waitFor(() =>
				expect(screen.getByRole("alert")).toHaveTextContent("Synthetic removal refused"),
			);
			await waitFor(() => expect(screen.getByText(selected.title!)).toBeInTheDocument());
			await waitFor(() => expect(reads).toBeGreaterThan(0));
			for (const trigger of screen.getAllByRole("button", { name: "Remove" }))
				expect(trigger).not.toBeDisabled();
			accepted = true;
			if (
				mode === "selected-toolbar" &&
				!(screen.getByRole("checkbox") as HTMLInputElement).checked
			)
				fireEvent.click(screen.getByRole("checkbox"));
			selectRemoval(
				"Remove (keep in download client)",
				screen.getAllByRole("button", { name: "Remove" })[0],
			);
			await waitFor(() => expect(posts).toHaveLength(2));
			await waitFor(() => expect(screen.queryByText(selected.title!)).not.toBeInTheDocument());
			expect(posts).toEqual(
				Array.from({ length: 2 }, () => ({
					instanceId: "first",
					service: "radarr",
					itemId: 11,
					action: "delete",
					removeFromClient: false,
					blocklist: false,
					changeCategory: false,
					search: false,
				})),
			);
		},
	);
});
