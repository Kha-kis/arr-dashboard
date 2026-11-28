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
	user: { id: "1", title: "Synthetic viewer", thumb: "" },
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
	it.each([null, "007", "9007199254740993"])(
		"keeps a playable session visible without using optional user ID %s as its label",
		async (id) => {
			vi.mocked(fetchNowPlaying).mockResolvedValue({
				sessions: [{ ...session, user: { ...session.user, id } }],
				totalBandwidth: 1000,
				availability: complete,
			});
			mount(variant, { plex: true, jellyfin: false, tautulli: false });
			await screen.findByText("Synthetic movie");
			expect(
				screen.getByText(
					variant === "compact"
						? "Synthetic viewer"
						: "Synthetic viewer · Synthetic player (Synthetic platform)",
				),
			).toBeInTheDocument();
			if (id !== null) expect(screen.queryByText(id)).not.toBeInTheDocument();
		},
	);
	it("labels DirectStream distinctly and never calls unknown audio transcoded", async () => {
		vi.mocked(fetchNowPlaying).mockResolvedValue({
			sessions: [
				{
					...session,
					videoDecision: "DirectStream",
					audioDecision: "unknown",
					audioCodec: "aac",
					videoResolution: "1920x1080",
				},
			],
			totalBandwidth: 1000,
			availability: complete,
		});
		mount(variant, { plex: true, jellyfin: false, tautulli: false });
		await screen.findByText("Synthetic movie");
		expect(screen.getByText(/Direct Stream/)).toHaveTextContent("1920x1080");
		expect(screen.queryByText(/Direct Play|AAC \(Transcode\)/)).not.toBeInTheDocument();
		expect(screen.getByText(/AAC/)).toHaveTextContent(/unknown/i);
	});
	it("does not turn a missing video method into a Transcode badge", async () => {
		vi.mocked(fetchNowPlaying).mockResolvedValue({
			sessions: [{ ...session, videoDecision: "" }],
			totalBandwidth: 1000,
			availability: complete,
		});
		mount(variant, { plex: true, jellyfin: false, tautulli: false });
		await screen.findByText("Synthetic movie");
		expect(screen.getByText(/Playback unknown/i)).toBeInTheDocument();
		expect(screen.queryByText(/^Transcode$/i)).not.toBeInTheDocument();
	});
	it("shows an explicit zero rate rather than hiding it", async () => {
		vi.mocked(fetchNowPlaying).mockResolvedValue({
			sessions: [{ ...session, bandwidth: 0 }],
			totalBandwidth: 0,
			availability: complete,
			bandwidthBasis: "provider-reported",
			bandwidthCoverage: {
				status: "complete",
				observedSessions: 1,
				measuredSessions: 1,
				knownTotalKbps: 0,
			},
		});
		mount(variant, { plex: true, jellyfin: false, tautulli: false });
		await screen.findByText("Synthetic movie");
		expect(screen.getByLabelText("Session stream rate")).toHaveTextContent("0 kbps");
		expect(screen.getByLabelText("Observed stream rate summary")).toHaveTextContent(
			/reported.*0 kbps/i,
		);
	});
	it("shows a known subtotal with measurement counts without treating missing rates as zero", async () => {
		vi.mocked(fetchNowPlaying).mockResolvedValue({
			sessions: [
				session,
				{ ...session, sessionKey: "second", title: "Second observation", bandwidth: undefined },
			],
			totalBandwidth: 1000,
			availability: complete,
			bandwidthBasis: "provider-reported",
			bandwidthCoverage: {
				status: "partial",
				observedSessions: 2,
				measuredSessions: 1,
				knownTotalKbps: 1000,
			},
		});
		mount(variant, { plex: true, jellyfin: false, tautulli: false });
		await screen.findByText("Second observation");
		expect(screen.getByLabelText("Observed stream rate summary")).toHaveTextContent(
			/known subtotal.*1\.0 Mbps.*1\/2/i,
		);
		expect(screen.getAllByLabelText("Session stream rate")[1]).toHaveTextContent(/unknown/i);
		expect(screen.getByText(/2 active streams/i)).toBeInTheDocument();
	});
	it("does not certify legacy numeric rate totals without measurement metadata", async () => {
		vi.mocked(fetchNowPlaying).mockResolvedValue({
			sessions: [session],
			totalBandwidth: 1000,
			availability: complete,
		});
		mount(variant, { plex: true, jellyfin: false, tautulli: false });
		await screen.findByText("Synthetic movie");
		expect(screen.getByLabelText("Observed stream rate summary")).toHaveTextContent(/unverified/i);
		expect(screen.getByLabelText("Session stream rate")).toHaveTextContent(/unverified/i);
	});
	it("discloses zero measured rows when a healthy provider omits every rate", async () => {
		vi.mocked(fetchNowPlaying).mockResolvedValue({
			sessions: [{ ...session, bandwidth: undefined }],
			totalBandwidth: 0,
			availability: complete,
			bandwidthBasis: "provider-reported",
			bandwidthCoverage: {
				status: "unavailable",
				observedSessions: 1,
				measuredSessions: 0,
				knownTotalKbps: null,
			},
		});
		mount(variant, { plex: true, jellyfin: false, tautulli: false });
		await screen.findByText("Synthetic movie");
		expect(screen.getByLabelText("Observed stream rate summary")).toHaveTextContent(
			/unknown.*0\/1/i,
		);
		expect(screen.getByLabelText("Session stream rate")).toHaveTextContent(/unknown/i);
		expect(screen.queryByText(/0 kbps/)).not.toBeInTheDocument();
	});
	it("does not trust a measurement receipt that disagrees with its session rows", async () => {
		vi.mocked(fetchNowPlaying).mockResolvedValue({
			sessions: [{ ...session, bandwidth: undefined }],
			totalBandwidth: 0,
			availability: complete,
			bandwidthBasis: "provider-reported",
			bandwidthCoverage: {
				status: "complete",
				observedSessions: 1,
				measuredSessions: 1,
				knownTotalKbps: 0,
			},
		});
		mount(variant, { plex: true, jellyfin: false, tautulli: false });
		await screen.findByText("Synthetic movie");
		expect(screen.getByLabelText("Observed stream rate summary")).toHaveTextContent(/unverified/i);
		expect(screen.getByLabelText("Session stream rate")).toHaveTextContent(/unverified/i);
	});
	it("renders native Jellyfin/Emby Direct Play quality even when rate evidence is absent", async () => {
		vi.mocked(fetchJellyfinNowPlaying).mockResolvedValue({
			sessions: [
				{
					sessionId: "native-direct",
					title: "Native direct observation",
					type: "Movie",
					user: "Synthetic viewer",
					player: "Synthetic player",
					deviceName: "Synthetic device",
					state: "playing",
					viewOffset: 0,
					duration: 60000,
					videoDecision: "direct play",
					audioDecision: "direct play",
					videoCodec: "hevc",
					audioCodec: "eac3",
					videoResolution: "3840x2160",
					instanceId: "native-source",
					instanceName: "Synthetic instance",
				},
			],
			totalBandwidth: 0,
			availability: complete,
			bandwidthBasis: "encoding-estimate",
			bandwidthCoverage: {
				status: "unavailable",
				observedSessions: 1,
				measuredSessions: 0,
				knownTotalKbps: null,
			},
		});
		mount(variant, { plex: false, jellyfin: true, tautulli: false });
		await screen.findByText("Native direct observation");
		expect(screen.getByText(/Direct Play/)).toHaveTextContent(/HEVC.*3840x2160/);
		expect(screen.getByText(/EAC3/)).toBeInTheDocument();
		expect(screen.getByLabelText("Session stream rate")).toHaveTextContent(/unknown/i);
		expect(screen.getByLabelText("Observed stream rate summary")).toHaveTextContent(
			/unknown.*0\/1/i,
		);
		expect(screen.queryByText(/0 kbps/)).not.toBeInTheDocument();
	});
	it("labels Jellyfin encoding estimates and renders its native output quality", async () => {
		vi.mocked(fetchJellyfinNowPlaying).mockResolvedValue({
			sessions: [
				{
					sessionId: "jellyfin-session",
					title: "Jellyfin observation",
					type: "Movie",
					user: "Synthetic viewer",
					player: "Synthetic player",
					deviceName: "Synthetic device",
					state: "playing",
					viewOffset: 0,
					duration: 60000,
					videoDecision: "copy",
					audioDecision: "transcode",
					videoCodec: "h264",
					audioCodec: "aac",
					videoResolution: "1920x1080",
					bandwidth: 1234.5,
					instanceId: "jellyfin-one",
					instanceName: "Synthetic instance",
				},
			],
			totalBandwidth: 1234.5,
			availability: complete,
			bandwidthBasis: "encoding-estimate",
			bandwidthCoverage: {
				status: "complete",
				observedSessions: 1,
				measuredSessions: 1,
				knownTotalKbps: 1234.5,
			},
		});
		mount(variant, { plex: false, jellyfin: true, tautulli: false });
		await screen.findByText("Jellyfin observation");
		expect(screen.getByLabelText("Observed stream rate summary")).toHaveTextContent(
			/estimated.*1\.2 Mbps/i,
		);
		expect(screen.getByText(/Direct Stream/)).toHaveTextContent(/H264.*1920x1080/);
		expect(screen.getByText(/AAC/)).toHaveTextContent("Transcode");
		expect(screen.getByLabelText("Session stream rate")).toHaveTextContent(/estimated/i);
	});
	it("retains failed-refetch measurements as last-known, then recovers to explicit zero", async () => {
		vi.mocked(fetchNowPlaying).mockResolvedValue({
			sessions: [session],
			totalBandwidth: 1000,
			availability: complete,
			bandwidthBasis: "provider-reported",
			bandwidthCoverage: {
				status: "complete",
				observedSessions: 1,
				measuredSessions: 1,
				knownTotalKbps: 1000,
			},
		});
		const client = mount(variant, { plex: true, jellyfin: false, tautulli: false });
		await screen.findByText("Synthetic movie");
		expect(screen.getByLabelText("Observed stream rate summary")).toHaveTextContent(
			/reported.*1\.0 Mbps/i,
		);
		vi.mocked(fetchNowPlaying).mockRejectedValue(privateError);
		await act(async () => {
			await client.invalidateQueries({ queryKey: plexKeys.nowPlaying() });
		});
		await waitFor(() => expect(screen.getByRole("status")).toHaveTextContent(/stale|last-known/i));
		expect(screen.getByLabelText("Observed stream rate summary")).toHaveTextContent(
			/current.*unknown/i,
		);
		expect(screen.getByLabelText("Session stream rate")).toHaveTextContent(
			/1\.0 Mbps.*last-known/i,
		);
		expect(screen.queryByText(privateError.message)).not.toBeInTheDocument();
		vi.mocked(fetchNowPlaying).mockResolvedValue({
			sessions: [{ ...session, bandwidth: 0 }],
			totalBandwidth: 0,
			availability: complete,
			bandwidthBasis: "provider-reported",
			bandwidthCoverage: {
				status: "complete",
				observedSessions: 1,
				measuredSessions: 1,
				knownTotalKbps: 0,
			},
		});
		await act(async () => {
			await client.invalidateQueries({ queryKey: plexKeys.nowPlaying() });
		});
		await waitFor(() =>
			expect(screen.getByLabelText("Session stream rate")).toHaveTextContent("0 kbps"),
		);
		expect(screen.getByLabelText("Observed stream rate summary")).toHaveTextContent(
			/reported.*0 kbps/i,
		);
		expect(screen.getByLabelText("Session stream rate")).not.toHaveTextContent(/last-known/i);
	});
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
