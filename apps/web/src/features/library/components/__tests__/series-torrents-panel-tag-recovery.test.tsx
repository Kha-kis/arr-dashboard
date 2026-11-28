import { quiCapabilitiesSchema } from "@arr/shared";
import { QueryClient, QueryClientProvider } from "@tanstack/react-query";
import { act, cleanup, fireEvent, render, screen, waitFor, within } from "@testing-library/react";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { IncognitoProvider } from "../../../../contexts/IncognitoContext";
import type { SeriesTorrentCopy, SeriesTorrentsResponse } from "../../../../lib/api-client/qui";
import * as api from "../../../../lib/api-client/qui";
import { quiKeys } from "../../../../lib/query-keys";
import { ColorThemeProvider } from "../../../../providers/color-theme-provider";
import { SeriesTorrentsPanel } from "../series-torrents-panel";

vi.mock("../../../../lib/api-client/qui");
vi.mock("../../../../lib/api-client/services", () => ({ fetchServices: async () => [] }));
vi.mock("../../../../components/ui/toast", () => ({
	toast: { success: vi.fn(), error: vi.fn() },
}));
const clients: QueryClient[] = [];
const acknowledged = { status: "success", logRowCount: 1 } as const;
const copy: SeriesTorrentCopy = {
	quiInstanceId: "qui-1",
	qbitInstanceId: 7,
	infoHash: "a".repeat(40),
	name: "Synthetic torrent",
	role: "library",
	state: "seeding",
	progress: 1,
	torrentSizeBytes: "1",
	ratio: 1,
	seedingTime: 0,
	numSeeds: 0,
	numLeechs: 0,
	dlSpeedBps: 0,
	upSpeedBps: 0,
	tracker: null,
	trackerHostnames: [],
	trackers: [],
	trackerHealth: null,
	peerSources: { dht: false, pex: false, lsd: false },
	instanceName: "Synthetic qBit",
	tags: ["seed", "retain"],
	category: "existing",
	savePath: "/synthetic",
	addedOn: 0,
	quiUnreachable: false,
};
function response(copies: SeriesTorrentCopy[] = [copy]): SeriesTorrentsResponse {
	return {
		seriesTitle: "Synthetic item",
		coverageStatus: "complete",
		totalEpisodes: 1,
		correlatedEpisodes: 1,
		viaInodeEpisodes: 0,
		stuckEpisodes: 0,
		healedEpisodes: 0,
		actionItems: [],
		seasonGroups: [],
		clusters: [
			{
				key: "cluster-1",
				episodeFileIds: [1],
				episodeCount: 1,
				seasons: [1],
				coverageLabel: "Synthetic coverage",
				totalSizeBytes: "1",
				qualityName: null,
				releaseGroup: null,
				inodeVerified: true,
				copies,
				isDormant: false,
				primaryState: "seeding",
				coveredBy: null,
			},
		],
	};
}
async function mount(itemType: "series" | "movie" = "series") {
	const client = new QueryClient({
		defaultOptions: { queries: { retry: false, gcTime: Infinity }, mutations: { retry: false } },
	});
	clients.push(client);
	render(
		<QueryClientProvider client={client}>
			<ColorThemeProvider>
				<IncognitoProvider>
					<SeriesTorrentsPanel
						arrInstanceId="arr-1"
						arrItemId={1}
						seriesTitle="Synthetic item"
						itemType={itemType}
					/>
				</IncognitoProvider>
			</ColorThemeProvider>
		</QueryClientProvider>,
	);
	await screen.findByText("Synthetic coverage");
	fireEvent.click(screen.getByText("Synthetic coverage"));
	fireEvent.click(await screen.findByRole("button", { name: "Open torrent details" }));
	const dialog = within(await screen.findByRole("dialog"));
	await dialog.findByRole("button", { name: "Remove tag seed" });
	return { client, dialog };
}
function addTag(dialog: ReturnType<typeof within>, tag: string) {
	const input = dialog.getByPlaceholderText("Pick or type a tag");
	fireEvent.change(input, { target: { value: tag } });
	fireEvent.click(within(input.parentElement!).getByRole("button", { name: "Add" }));
}
beforeEach(() => {
	vi.resetAllMocks();
	vi.mocked(api.fetchSeriesTorrents).mockImplementation(async () => response());
	vi.mocked(api.fetchMovieTorrents).mockImplementation(async () => response());
	vi.mocked(api.fetchTrackerIcons).mockResolvedValue({ trackers: {} });
	vi.mocked(api.fetchQuiCapabilities).mockResolvedValue({
		capabilities: quiCapabilitiesSchema.parse({}),
	});
	vi.mocked(api.fetchQuiTags).mockResolvedValue({ tags: [] });
	vi.mocked(api.fetchQuiCategories).mockResolvedValue({ categories: [] });
	vi.mocked(api.fetchQuiTorrentTrackers).mockResolvedValue({ trackers: [] });
	vi.mocked(api.postQuiTorrentAction).mockResolvedValue(acknowledged);
	vi.stubGlobal("fetch", vi.fn().mockRejectedValue(new Error("Network forbidden in fixture")));
});
afterEach(() => {
	cleanup();
	for (const client of clients.splice(0)) client.clear();
	expect(fetch).not.toHaveBeenCalled();
	vi.unstubAllGlobals();
});

describe("Real panel-to-drawer tag observation recovery", () => {
	it("recovers the real open drawer without secure-context randomUUID", async () => {
		const getRandomValues = crypto.getRandomValues.bind(crypto);
		vi.stubGlobal("crypto", { getRandomValues });
		const { dialog } = await mount();
		vi.mocked(api.fetchSeriesTorrents).mockImplementation(async () =>
			response([{ ...copy, tags: ["seed", "retain", "A"] }]),
		);
		addTag(dialog, "A");
		await dialog.findByRole("button", { name: "Remove tag A" });
		await waitFor(() => expect(dialog.getByPlaceholderText("Pick or type a tag")).toBeEnabled());
		addTag(dialog, "B");
		await waitFor(() => expect(api.postQuiTorrentAction).toHaveBeenCalledTimes(2));
		expect(api.postQuiTorrentAction).toHaveBeenLastCalledWith(
			expect.objectContaining({ payload: { tags: "seed,retain,A,B" } }),
		);
	});

	it.each(["acknowledged", "unconfirmed"] as const)(
		"retains the %s tag attempt across close/settle/reopen and recovers without replay",
		async (outcome) => {
			let resolve!: (value: typeof acknowledged) => void;
			let reject!: (reason: Error) => void;
			vi.mocked(api.postQuiTorrentAction).mockReturnValueOnce(
				new Promise((done, fail) => {
					resolve = done;
					reject = fail;
				}),
			);
			const { client, dialog } = await mount();
			addTag(dialog, "A");
			await waitFor(() => expect(client.isMutating()).toBe(1));
			fireEvent.click(dialog.getByRole("button", { name: "Close" }));
			await waitFor(() => expect(screen.queryByRole("dialog")).not.toBeInTheDocument());
			vi.mocked(api.fetchSeriesTorrents).mockRejectedValue(new Error("Synthetic read unavailable"));
			await act(async () => {
				if (outcome === "acknowledged") resolve(acknowledged);
				else reject(new Error("Dashboard response lost after provider success"));
			});
			await waitFor(() => expect(client.isMutating()).toBe(0));
			fireEvent.click(screen.getByRole("button", { name: "Open torrent details" }));
			const reopened = within(await screen.findByRole("dialog"));
			await reopened.findByText(/showing last-known tags until torrent data refreshes/i);
			await waitFor(() => expect(api.fetchSeriesTorrents).toHaveBeenCalledTimes(2));
			expect(reopened.getByPlaceholderText("Pick or type a tag")).toBeDisabled();
			addTag(reopened, "B");
			expect(api.postQuiTorrentAction).toHaveBeenCalledTimes(1);
			vi.mocked(api.fetchSeriesTorrents).mockImplementation(async () =>
				response([{ ...copy, tags: ["seed", "retain", "A"] }]),
			);
			fireEvent.click(reopened.getByRole("button", { name: "Refresh torrent data" }));
			await reopened.findByRole("button", { name: "Remove tag A" });
			await waitFor(() =>
				expect(reopened.getByPlaceholderText("Pick or type a tag")).toBeEnabled(),
			);
			expect(api.postQuiTorrentAction).toHaveBeenCalledTimes(1);
			addTag(reopened, "B");
			await waitFor(() => expect(api.postQuiTorrentAction).toHaveBeenCalledTimes(2));
			expect(api.postQuiTorrentAction).toHaveBeenLastCalledWith(
				expect.objectContaining({ payload: { tags: "seed,retain,A,B" } }),
			);
		},
	);

	it("keeps a reopened drawer fenced while its original tag attempt is still pending", async () => {
		let resolve!: (value: typeof acknowledged) => void;
		vi.mocked(api.postQuiTorrentAction).mockReturnValueOnce(
			new Promise((done) => {
				resolve = done;
			}),
		);
		const { client, dialog } = await mount();
		addTag(dialog, "A");
		await waitFor(() => expect(client.isMutating()).toBe(1));
		let completed = false;
		try {
			fireEvent.click(dialog.getByRole("button", { name: "Close" }));
			await waitFor(() => expect(screen.queryByRole("dialog")).not.toBeInTheDocument());
			fireEvent.click(screen.getByRole("button", { name: "Open torrent details" }));
			const reopened = within(await screen.findByRole("dialog"));
			expect(reopened.getByPlaceholderText("Pick or type a tag")).toBeDisabled();
			addTag(reopened, "B");
			expect(api.postQuiTorrentAction).toHaveBeenCalledTimes(1);
			vi.mocked(api.fetchSeriesTorrents).mockImplementation(async () =>
				response([{ ...copy, tags: ["seed", "retain", "A"] }]),
			);
			await act(async () => {
				resolve(acknowledged);
				completed = true;
			});
			await reopened.findByRole("button", { name: "Remove tag A" });
			await waitFor(() =>
				expect(reopened.getByPlaceholderText("Pick or type a tag")).toBeEnabled(),
			);
		} finally {
			if (!completed) await act(async () => resolve(acknowledged));
		}
	});

	it("removes the final tag with an explicit empty replacement and observes the empty result", async () => {
		vi.mocked(api.fetchSeriesTorrents).mockImplementation(async () =>
			response([{ ...copy, tags: ["only-tag"] }]),
		);
		// mount waits for the ordinary panel and opens the real drawer.
		const client = new QueryClient({
			defaultOptions: { queries: { retry: false }, mutations: { retry: false } },
		});
		clients.push(client);
		render(
			<QueryClientProvider client={client}>
				<ColorThemeProvider>
					<IncognitoProvider>
						<SeriesTorrentsPanel arrInstanceId="arr-1" arrItemId={1} seriesTitle="Synthetic item" />
					</IncognitoProvider>
				</ColorThemeProvider>
			</QueryClientProvider>,
		);
		fireEvent.click(await screen.findByText("Synthetic coverage"));
		fireEvent.click(await screen.findByRole("button", { name: "Open torrent details" }));
		const dialog = within(await screen.findByRole("dialog"));
		vi.mocked(api.fetchSeriesTorrents).mockImplementation(async () =>
			response([{ ...copy, tags: [] }]),
		);
		fireEvent.click(await dialog.findByRole("button", { name: "Remove tag only-tag" }));
		await waitFor(() =>
			expect(api.postQuiTorrentAction).toHaveBeenCalledExactlyOnceWith({
				quiInstanceId: "qui-1",
				qbitInstanceId: 7,
				hash: "a".repeat(40),
				action: "setTags",
				payload: { tags: "" },
			}),
		);
		await dialog.findByText("No tags");
		await waitFor(() => expect(dialog.getByPlaceholderText("Pick or type a tag")).toBeEnabled());
	});

	it.each(["series", "movie"] as const)(
		"refreshes the open %s drawer after acknowledgement before deriving a second replacement",
		async (itemType) => {
			const { dialog } = await mount(itemType);
			const fetcher = itemType === "series" ? api.fetchSeriesTorrents : api.fetchMovieTorrents;
			vi.mocked(fetcher).mockImplementation(async () =>
				response([{ ...copy, tags: ["seed", "retain", "A"] }]),
			);
			addTag(dialog, "A");
			await waitFor(() => expect(api.postQuiTorrentAction).toHaveBeenCalledTimes(1));
			await dialog.findByRole("button", { name: "Remove tag A" });
			await waitFor(() => expect(dialog.getByPlaceholderText("Pick or type a tag")).toBeEnabled());
			addTag(dialog, "B");
			await waitFor(() => expect(api.postQuiTorrentAction).toHaveBeenCalledTimes(2));
			expect(api.postQuiTorrentAction).toHaveBeenLastCalledWith({
				quiInstanceId: "qui-1",
				qbitInstanceId: 7,
				hash: "a".repeat(40),
				action: "setTags",
				payload: { tags: "seed,retain,A,B" },
			});
		},
	);

	it("blocks a different edit after applied-but-response-lost until an explicit successful read preserves the applied tag", async () => {
		const { dialog } = await mount();
		vi.mocked(api.postQuiTorrentAction).mockRejectedValueOnce(
			new Error("Dashboard response lost after provider success"),
		);
		vi.mocked(api.fetchSeriesTorrents).mockRejectedValue(new Error("Synthetic read unavailable"));
		addTag(dialog, "A");
		await dialog.findByText(/change was not confirmed/i);
		await waitFor(() => expect(api.fetchSeriesTorrents).toHaveBeenCalledTimes(2));
		expect(dialog.getByPlaceholderText("Pick or type a tag")).toBeDisabled();
		addTag(dialog, "B");
		expect(api.postQuiTorrentAction).toHaveBeenCalledTimes(1);
		vi.mocked(api.fetchSeriesTorrents).mockImplementation(async () =>
			response([{ ...copy, tags: ["seed", "retain", "A"] }]),
		);
		fireEvent.click(dialog.getByRole("button", { name: "Refresh torrent data" }));
		await dialog.findByRole("button", { name: "Remove tag A" });
		await waitFor(() => expect(dialog.getByPlaceholderText("Pick or type a tag")).toBeEnabled());
		expect(api.postQuiTorrentAction).toHaveBeenCalledTimes(1);
		addTag(dialog, "B");
		await waitFor(() => expect(api.postQuiTorrentAction).toHaveBeenCalledTimes(2));
		expect(api.postQuiTorrentAction).toHaveBeenLastCalledWith(
			expect.objectContaining({ payload: { tags: "seed,retain,A,B" } }),
		);
	});

	it("accepts a successful unchanged-tag observation even when React Query structurally shares the old array", async () => {
		const { dialog, client } = await mount();
		const previous = client.getQueryData<SeriesTorrentsResponse>(quiKeys.seriesTorrents("arr-1", 1))
			?.clusters[0]?.copies[0]?.tags;
		vi.mocked(api.postQuiTorrentAction).mockRejectedValueOnce(
			new Error("Synthetic rejected addition"),
		);
		addTag(dialog, "A");
		await dialog.findByText(/change was not confirmed/i);
		await waitFor(() => expect(api.fetchSeriesTorrents).toHaveBeenCalledTimes(2));
		await waitFor(() => expect(dialog.getByPlaceholderText("Pick or type a tag")).toBeEnabled());
		expect(
			client.getQueryData<SeriesTorrentsResponse>(quiKeys.seriesTorrents("arr-1", 1))?.clusters[0]
				?.copies[0]?.tags,
		).toBe(previous);
		addTag(dialog, "B");
		await waitFor(() => expect(api.postQuiTorrentAction).toHaveBeenCalledTimes(2));
		expect(api.postQuiTorrentAction).toHaveBeenLastCalledWith(
			expect.objectContaining({ payload: { tags: "seed,retain,B" } }),
		);
	});

	it.each(["missing", "other-qbit", "other-qui", "unreachable", "ambiguous"])(
		"does not unlock a tag replacement from a %s target observation",
		async (kind) => {
			const { dialog } = await mount();
			const observed =
				kind === "missing"
					? []
					: kind === "other-qbit"
						? [{ ...copy, qbitInstanceId: 8 }]
						: kind === "other-qui"
							? [{ ...copy, quiInstanceId: "qui-2" }]
							: kind === "unreachable"
								? [{ ...copy, quiUnreachable: true }]
								: [copy, { ...copy }];
			vi.mocked(api.fetchSeriesTorrents).mockImplementation(async () => response(observed));
			vi.mocked(api.postQuiTorrentAction).mockRejectedValueOnce(
				new Error("Synthetic uncertain addition"),
			);
			addTag(dialog, "A");
			await dialog.findByText(/change was not confirmed/i);
			await waitFor(() => expect(api.fetchSeriesTorrents).toHaveBeenCalledTimes(2));
			expect(dialog.getByPlaceholderText("Pick or type a tag")).toBeDisabled();
			addTag(dialog, "B");
			expect(api.postQuiTorrentAction).toHaveBeenCalledTimes(1);
		},
	);

	it("does not use a read that completed while the mutation was still pending as post-attempt evidence", async () => {
		let reject!: (reason: Error) => void;
		vi.mocked(api.postQuiTorrentAction).mockReturnValueOnce(
			new Promise((_, fail) => {
				reject = fail;
			}),
		);
		const { client, dialog } = await mount();
		addTag(dialog, "A");
		await waitFor(() => expect(client.isMutating()).toBe(1));
		await act(async () => {
			await client.invalidateQueries({ queryKey: quiKeys.seriesTorrentsAll });
		});
		vi.mocked(api.fetchSeriesTorrents).mockRejectedValue(new Error("Post-attempt read failed"));
		await act(async () => reject(new Error("Synthetic response lost")));
		await dialog.findByText(/change was not confirmed/i);
		await waitFor(() => expect(api.fetchSeriesTorrents).toHaveBeenCalledTimes(3));
		expect(dialog.getByPlaceholderText("Pick or type a tag")).toBeDisabled();
		expect(api.postQuiTorrentAction).toHaveBeenCalledTimes(1);
	});
});
