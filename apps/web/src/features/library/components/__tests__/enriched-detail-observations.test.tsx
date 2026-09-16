import type { LibraryItem } from "@arr/shared";
import { fireEvent, render, screen } from "@testing-library/react";
import { beforeEach, describe, expect, it, vi } from "vitest";
import { IncognitoProvider } from "../../../../contexts/IncognitoContext";

const queryState = vi.hoisted(() => ({ available: true }));

vi.mock("../../../../hooks/api/useSeerr", () => ({
	useSeerrMovieDetails: () => ({}),
	useSeerrTvDetails: () => ({}),
}));
vi.mock("../../../../hooks/api/useLibrary", () => ({ useMovieFileQuery: () => ({}) }));
vi.mock("../../../../hooks/useThemeGradient", () => ({
	useThemeGradient: () => ({ gradient: { from: "#123456", to: "#654321" } }),
}));
vi.mock("../../../../hooks/api/useLibraryEpisodeWatchStatus", () => ({
	useLibraryEpisodeWatchStatus: () => ({
		episodes: queryState.available
			? [1, 2].map((episodeNumber) => ({
					seasonNumber: 1,
					episodeNumber,
					title: `Private episode ${episodeNumber}`,
					watched: true,
					watchedByUsers: ["Private viewer"],
					lastWatchedAt: "2026-09-01T00:00:00.000Z",
				}))
			: undefined,
		providerStatus: {
			availability: "partial",
			sources: [
				{
					instanceId: "native",
					service: "jellyfin",
					cacheType: "jellyfin_episode",
					status: {
						availability: "partial",
						evidence: "positive-only",
						observedAt: "2026-09-01T00:00:00.000Z",
						ageSeconds: 0,
						latestAttempt: "successful",
						reasonCodes: ["coverage-incomplete"],
					},
				},
			],
		},
		plexEvidence: {
			availability: "current",
			publicationLevel: "positive-only",
			completeness: "partial",
			attemptState: "success",
		},
	}),
}));
vi.mock("../season-episode-list", () => ({ SeasonEpisodeList: () => null }));
vi.mock("../series-torrents-panel", () => ({ SeriesTorrentsPanel: () => null }));
vi.mock("../plex-tags-editor", () => ({ PlexTagsEditor: () => null }));
vi.mock("../poster-image", () => ({ PosterImage: () => null }));

import { EnrichedDetailModal } from "../enriched-detail-modal";

const item = {
	id: 1,
	type: "series",
	title: "Synthetic series",
	sortTitle: "Synthetic series",
	instanceId: "arr",
	instanceName: "Synthetic Sonarr",
	service: "sonarr",
	monitored: true,
	remoteIds: { tmdbId: 101 },
	seasons: [{ seasonNumber: 1, monitored: true, episodeCount: 12, episodeFileCount: 12 }],
} as unknown as LibraryItem;

describe("native episode observation details", () => {
	beforeEach(() => {
		localStorage.clear();
		queryState.available = true;
	});
	it("keeps the Plex modal available before episode rows arrive", () => {
		queryState.available = false;
		render(
			<IncognitoProvider>
				<EnrichedDetailModal
					item={item}
					seerrInstanceId="seerr"
					episodeProvider="plex"
					onClose={vi.fn()}
				/>
			</IncognitoProvider>,
		);
		expect(screen.getByRole("dialog")).toBeInTheDocument();
		expect(screen.getByText(/No Plex rows are being shown/)).toBeInTheDocument();
		expect(screen.queryByText(/Confirmed Plex rows are shown/)).not.toBeInTheDocument();
	});
	it.each(["plex", "jellyfin"] as const)(
		"labels partial %s rows as observations without a season denominator",
		(provider) => {
			render(
				<IncognitoProvider>
					<EnrichedDetailModal
						item={item}
						seerrInstanceId="seerr"
						episodeProvider={provider}
						onClose={vi.fn()}
					/>
				</IncognitoProvider>,
			);
			fireEvent.click(screen.getByRole("button", { name: /Season 1/ }));
			expect(screen.getByText("Private episode 1")).toBeInTheDocument();
			expect(screen.getByText("Private episode 2")).toBeInTheDocument();
			expect(screen.queryByText(/\d+\/\d+ watched/)).not.toBeInTheDocument();
			expect(screen.getByText(/Observed watched episodes: 2/)).toBeInTheDocument();
			if (provider === "plex") {
				expect(
					screen.getByText(/Confirmed Plex rows are shown; omitted rows remain unknown/),
				).toBeInTheDocument();
				expect(screen.queryByText(/No Plex rows are being shown/)).not.toBeInTheDocument();
			}
		},
	);
	it.each(["plex", "jellyfin"] as const)(
		"redacts %s episode titles and viewer tooltips in incognito mode",
		(provider) => {
			localStorage.setItem("arr-dashboard-incognito-mode", "true");
			const { container } = render(
				<IncognitoProvider>
					<EnrichedDetailModal
						item={item}
						seerrInstanceId="seerr"
						episodeProvider={provider}
						onClose={vi.fn()}
					/>
				</IncognitoProvider>,
			);
			fireEvent.click(screen.getByRole("button", { name: /Season 1/ }));
			expect(screen.getByText("E01")).toBeInTheDocument();
			expect(screen.getByText("E02")).toBeInTheDocument();
			expect(container.innerHTML).not.toContain("Private episode");
			expect(container.innerHTML).not.toContain("Private viewer");
		},
	);
});
