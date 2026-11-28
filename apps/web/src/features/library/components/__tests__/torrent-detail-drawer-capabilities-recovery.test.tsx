import { quiCapabilitiesSchema } from "@arr/shared";
import { QueryClient, QueryClientProvider } from "@tanstack/react-query";
import { act, cleanup, fireEvent, render, screen, waitFor } from "@testing-library/react";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { IncognitoProvider } from "../../../../contexts/IncognitoContext";
import type { SeriesTorrentCopy } from "../../../../lib/api-client/qui";
import * as api from "../../../../lib/api-client/qui";
import { ColorThemeProvider } from "../../../../providers/color-theme-provider";
import { TorrentDetailDrawer } from "../torrent-detail-drawer";

vi.mock("../../../../lib/api-client/qui");
vi.mock("../../../../lib/api-client/services", () => ({ fetchServices: async () => [] }));
const clients: QueryClient[] = [];
const key = ["qui", "capabilities", "qui-1", 7];
const supported = {
	capabilities: quiCapabilitiesSchema.parse({
		supportsTrackerEditing: true,
		supportsShareLimitsAction: true,
	}),
};
const legacy = {
	capabilities: quiCapabilitiesSchema.parse({
		supportsTrackerEditing: false,
		supportsShareLimitsAction: true,
	}),
};
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
	tags: [],
	category: "",
	savePath: "/synthetic",
	addedOn: 0,
	quiUnreachable: false,
};
function mount(
	client = new QueryClient({
		defaultOptions: { queries: { retry: false, gcTime: Infinity }, mutations: { retry: false } },
	}),
) {
	clients.push(client);
	render(
		<QueryClientProvider client={client}>
			<ColorThemeProvider>
				<IncognitoProvider>
					<TorrentDetailDrawer copy={copy} onClose={vi.fn()} />
				</IncognitoProvider>
			</ColorThemeProvider>
		</QueryClientProvider>,
	);
	return client;
}
beforeEach(() => {
	vi.resetAllMocks();
	vi.mocked(api.fetchQuiCapabilities).mockResolvedValue(legacy);
	vi.mocked(api.fetchQuiTags).mockResolvedValue({ tags: [] });
	vi.mocked(api.fetchQuiCategories).mockResolvedValue({ categories: [] });
	vi.mocked(api.fetchQuiTorrentTrackers).mockResolvedValue({ trackers: [] });
	vi.mocked(api.fetchQuiTorrentProperties).mockResolvedValue({
		properties: {
			additionDate: 0,
			completionDate: 0,
			comment: "",
			totalSize: 1,
			totalDownloaded: 1,
			totalUploaded: 1,
			shareRatio: 1,
			uploadSpeed: 0,
			downloadSpeed: 0,
			uploadLimit: 0,
			downloadLimit: 0,
			seedsActual: 0,
			peersActual: 0,
			eta: 0,
			ratioLimit: 0,
			seedingTimeLimit: 0,
			inactiveSeedingTimeLimit: 0,
			savePath: "/synthetic",
		},
	});
	vi.stubGlobal("fetch", vi.fn().mockRejectedValue(new Error("Network forbidden in fixture")));
});
afterEach(() => {
	cleanup();
	for (const client of clients.splice(0)) client.clear();
	expect(fetch).not.toHaveBeenCalled();
	expect(api.postQuiTorrentAction).not.toHaveBeenCalled();
	vi.unstubAllGlobals();
});

describe("Torrent drawer capability read recovery with real hooks", () => {
	it("distinguishes unavailable capabilities from unsupported features, then retries the read", async () => {
		vi.mocked(api.fetchQuiCapabilities).mockRejectedValueOnce(new Error("Synthetic unavailable"));
		mount();
		await screen.findByText(/capabilities are unavailable; support could not be verified/i);
		expect(screen.queryByText(/doesn’t support/)).not.toBeInTheDocument();
		expect(api.fetchQuiCapabilities).toHaveBeenCalledTimes(1);
		fireEvent.click(screen.getByRole("button", { name: "Retry capabilities" }));
		await screen.findByText(/doesn’t support tracker editing/);
		expect(screen.queryByText(/support could not be verified/)).not.toBeInTheDocument();
		expect(api.fetchQuiCapabilities).toHaveBeenCalledTimes(2);
	});

	it("labels last-known flags after failed refresh and recovers through the same read retry", async () => {
		const client = new QueryClient({
			defaultOptions: { queries: { retry: false, gcTime: Infinity } },
		});
		client.setQueryData(key, supported);
		mount(client);
		vi.mocked(api.fetchQuiCapabilities).mockRejectedValueOnce(
			new Error("Synthetic failed refresh"),
		);
		await act(async () => {
			await client.invalidateQueries({ queryKey: key });
		});
		await screen.findByText(/showing last-known support flags/i);
		expect(screen.queryByText(/doesn’t support/)).not.toBeInTheDocument();
		fireEvent.click(screen.getByRole("button", { name: "Retry capabilities" }));
		await screen.findByText(/doesn’t support tracker editing/);
		expect(screen.queryByText(/showing last-known support flags/i)).not.toBeInTheDocument();
	});

	it("shows an active initial capability check without inventing unsupported flags", async () => {
		let resolve!: (value: typeof supported) => void;
		vi.mocked(api.fetchQuiCapabilities).mockReturnValueOnce(
			new Promise((done) => {
				resolve = done;
			}),
		);
		mount();
		try {
			await screen.findByText(/Checking qBittorrent capabilities/);
			expect(screen.queryByText(/doesn’t support/)).not.toBeInTheDocument();
		} finally {
			await act(async () => resolve(supported));
		}
		await waitFor(() =>
			expect(screen.queryByText(/Checking qBittorrent capabilities/)).not.toBeInTheDocument(),
		);
	});
});
