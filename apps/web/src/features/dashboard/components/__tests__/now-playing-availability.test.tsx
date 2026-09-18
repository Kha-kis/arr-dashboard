import type { PlexSession } from "@arr/shared";
import { QueryClient, QueryClientProvider } from "@tanstack/react-query";
import { act, cleanup, render, screen, waitFor } from "@testing-library/react";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { IncognitoProvider } from "../../../../contexts/IncognitoContext";
import { fetchJellyfinNowPlaying } from "../../../../lib/api-client/jellyfin";
import { fetchNowPlaying } from "../../../../lib/api-client/plex";
import { fetchTautulliActivity } from "../../../../lib/api-client/tautulli";
import { jellyfinKeys, plexKeys, tautulliKeys } from "../../../../lib/query-keys";
import { NowPlayingWidget } from "../now-playing-widget";

vi.mock("../../../../lib/api-client/plex", () => ({ fetchNowPlaying: vi.fn() }));
vi.mock("../../../../lib/api-client/jellyfin", () => ({ fetchJellyfinNowPlaying: vi.fn() }));
vi.mock("../../../../lib/api-client/tautulli", () => ({ fetchTautulliActivity: vi.fn() }));

const complete = { status: "complete" as const, configuredSources: 1, availableSources: 1 };
const partial = { status: "partial" as const, configuredSources: 2, availableSources: 1 };
const session: PlexSession = {
	sessionKey: "session-one",
	ratingKey: "item-one",
	title: "Synthetic movie",
	type: "movie",
	user: { id: 1, title: "Synthetic viewer", thumb: "" },
	player: {
		title: "Synthetic player",
		platform: "Synthetic platform",
		product: "Synthetic product",
		state: "playing",
	},
	state: "playing",
	viewOffset: 1000,
	duration: 60000,
	videoDecision: "direct play",
	audioDecision: "direct play",
	bandwidth: 1000,
	instanceId: "plex-one",
	instanceName: "Synthetic instance",
};
const privateError = new Error("PRIVATE_PROVIDER_DETAILS");
const clients: QueryClient[] = [];

function mount(
	variant: "compact" | "full",
	enabled = { plex: true, jellyfin: true, tautulli: false },
	seed?: (client: QueryClient) => void,
) {
	const client = new QueryClient({
		defaultOptions: { queries: { retry: false, gcTime: Infinity } },
	});
	seed?.(client);
	clients.push(client);
	render(
		<QueryClientProvider client={client}>
			<IncognitoProvider>
				<NowPlayingWidget
					variant={variant}
					hasPlexInstances={enabled.plex}
					hasJellyfinInstances={enabled.jellyfin}
					hasTautulliInstances={enabled.tautulli}
				/>
			</IncognitoProvider>
		</QueryClientProvider>,
	);
	return client;
}

beforeEach(() => {
	vi.mocked(fetchNowPlaying)
		.mockReset()
		.mockResolvedValue({ sessions: [], totalBandwidth: 0, availability: complete });
	vi.mocked(fetchJellyfinNowPlaying)
		.mockReset()
		.mockResolvedValue({ sessions: [], totalBandwidth: 0, availability: complete });
	vi.mocked(fetchTautulliActivity).mockReset().mockResolvedValue({
		sessions: [],
		streamCount: 0,
		totalBandwidth: 0,
		lanBandwidth: 0,
		wanBandwidth: 0,
		availability: complete,
	});
});
afterEach(() => {
	cleanup();
	for (const client of clients.splice(0)) client.clear();
});

describe.each(["compact", "full"] as const)("Now Playing %s availability", (variant) => {
	it("uses optional Tautulli activity when no native Plex connection is configured", async () => {
		vi.mocked(fetchTautulliActivity).mockResolvedValue({
			sessions: [
				{
					sessionKey: "fallback-one",
					ratingKey: "fallback-item",
					title: "Fallback movie",
					mediaType: "movie",
					user: "Fallback viewer",
					player: "Fallback player",
					platform: "Synthetic",
					product: "Synthetic",
					state: "playing",
					progressPercent: 20,
					transcodeDecision: "direct play",
					videoDecision: "direct play",
					audioDecision: "direct play",
					videoResolution: "1080",
					audioCodec: "aac",
					videoCodec: "h264",
					bandwidth: 1000,
					location: "lan",
					instanceId: "tautulli-one",
					instanceName: "Fallback source",
				},
			],
			streamCount: 1,
			totalBandwidth: 1000,
			lanBandwidth: 1000,
			wanBandwidth: 0,
			availability: complete,
		});
		mount(variant, { plex: false, jellyfin: false, tautulli: true });
		await screen.findByText("Fallback movie");
		expect(screen.getByText(/1 active stream/i)).toBeInTheDocument();
		expect(fetchNowPlaying).not.toHaveBeenCalled();
	});
	it("shows a cold unavailable state when every configured source fails", async () => {
		vi.mocked(fetchNowPlaying).mockRejectedValue(privateError);
		vi.mocked(fetchJellyfinNowPlaying).mockRejectedValue(privateError);
		mount(variant);
		await waitFor(() => expect(screen.getByRole("status")).toHaveTextContent(/unavailable/i));
		expect(screen.queryByText(/0 active streams|no active streams/i)).not.toBeInTheDocument();
	});
	it("keeps native Plex independent of optional Tautulli failure and cached data", async () => {
		vi.mocked(fetchNowPlaying).mockResolvedValue({
			sessions: [session],
			totalBandwidth: 1000,
			availability: complete,
		});
		vi.mocked(fetchTautulliActivity).mockRejectedValue(privateError);
		mount(variant, { plex: true, jellyfin: false, tautulli: true }, (client) => {
			client.setQueryData(tautulliKeys.activity(), {
				sessions: [{ title: "Stale optional source" }],
				totalBandwidth: 99999,
			});
		});
		await screen.findByText("Synthetic movie");
		expect(screen.getByText(/1 active stream/i)).toBeInTheDocument();
		expect(screen.queryByRole("status")).not.toBeInTheDocument();
		expect(screen.queryByText("Stale optional source")).not.toBeInTheDocument();
		expect(fetchTautulliActivity).not.toHaveBeenCalled();
	});
	it("keeps cross-instance session-key collisions as separate observations without exact totals", async () => {
		vi.mocked(fetchNowPlaying).mockResolvedValue({
			sessions: [session, { ...session, instanceId: "plex-two", title: "Second synthetic movie" }],
			totalBandwidth: 2000,
			availability: { status: "complete", configuredSources: 2, availableSources: 2 },
		});
		mount(variant, { plex: true, jellyfin: false, tautulli: false });
		await screen.findByText("Second synthetic movie");
		expect(screen.getByText("Synthetic movie")).toBeInTheDocument();
		expect(screen.getByRole("status")).toHaveTextContent(/overlap|duplicate/i);
		expect(screen.queryByText(/2 active streams/i)).not.toBeInTheDocument();
	});
	it("does not turn one failed provider plus healthy empty data into zero active streams", async () => {
		vi.mocked(fetchNowPlaying).mockRejectedValue(privateError);
		mount(variant);
		await waitFor(() =>
			expect(screen.getByRole("status")).toHaveTextContent(/unavailable|incomplete/i),
		);
		expect(screen.queryByText(/0 active streams|no active streams/i)).not.toBeInTheDocument();
		expect(screen.queryByText(privateError.message)).not.toBeInTheDocument();
	});
	it("keeps partial positive sessions with disclosure instead of exact current totals", async () => {
		vi.mocked(fetchNowPlaying).mockResolvedValue({
			sessions: [session],
			totalBandwidth: 1000,
			availability: partial,
		});
		mount(variant);
		await waitFor(() => expect(screen.getByRole("status")).toHaveTextContent(/incomplete/i));
		expect(screen.getByText("Synthetic movie")).toBeInTheDocument();
		expect(screen.queryByText(/1 active stream/i)).not.toBeInTheDocument();
	});
	it("retains populated warm data when every provider refetch fails, then recovers", async () => {
		vi.mocked(fetchNowPlaying).mockResolvedValue({
			sessions: [session],
			totalBandwidth: 1000,
			availability: complete,
		});
		const client = mount(variant);
		await screen.findByText("Synthetic movie");
		vi.mocked(fetchNowPlaying).mockRejectedValue(privateError);
		vi.mocked(fetchJellyfinNowPlaying).mockRejectedValue(privateError);
		await act(async () => {
			await Promise.all([
				client.invalidateQueries({ queryKey: plexKeys.nowPlaying() }),
				client.invalidateQueries({ queryKey: jellyfinKeys.nowPlaying() }),
			]);
		});
		await waitFor(() => expect(screen.getByRole("status")).toHaveTextContent(/stale|last-known/i));
		expect(screen.getByText("Synthetic movie")).toBeInTheDocument();
		expect(screen.queryByText(/1 active stream/i)).not.toBeInTheDocument();
		vi.mocked(fetchNowPlaying).mockResolvedValue({
			sessions: [],
			totalBandwidth: 0,
			availability: complete,
		});
		vi.mocked(fetchJellyfinNowPlaying).mockResolvedValue({
			sessions: [],
			totalBandwidth: 0,
			availability: complete,
		});
		await act(async () => {
			await Promise.all([
				client.invalidateQueries({ queryKey: plexKeys.nowPlaying() }),
				client.invalidateQueries({ queryKey: jellyfinKeys.nowPlaying() }),
			]);
		});
		await waitFor(() => expect(screen.queryByRole("status")).not.toBeInTheDocument());
		expect(screen.getByText(/0 active streams/i)).toBeInTheDocument();
	});
	it("does not treat an enabled query with no configured sources as an authoritative zero", async () => {
		vi.mocked(fetchNowPlaying).mockResolvedValue({
			sessions: [],
			totalBandwidth: 0,
			availability: { status: "not-configured", configuredSources: 0, availableSources: 0 },
		});
		mount(variant, { plex: true, jellyfin: false, tautulli: false });
		await waitFor(() => expect(screen.getByRole("status")).toHaveTextContent(/unavailable/i));
		expect(screen.queryByText(/0 active streams|no active streams/i)).not.toBeInTheDocument();
	});
});
