import type { LibraryItem, SeriesProgressItem } from "@arr/shared";
import { render, screen } from "@testing-library/react";
import { describe, expect, it, vi } from "vitest";
import { IncognitoProvider } from "../../../../contexts/IncognitoContext";
import { ColorThemeProvider } from "../../../../providers/color-theme-provider";
import { LibraryCard } from "../library-card";

vi.mock("../poster-image", () => ({ PosterImage: () => null }));
vi.mock("../torrent-state-badge", () => ({ TorrentStateBadge: () => null }));

const item = {
	id: 202,
	type: "series",
	title: "Progress Fixture",
	sortTitle: "Progress Fixture",
	instanceId: "arr-instance",
	instanceName: "Library ARR",
	service: "sonarr",
	monitored: true,
	hasFile: true,
	remoteIds: { tmdbId: 202 },
} as unknown as LibraryItem;

function renderCard(seriesProgress: { plex?: SeriesProgressItem; jellyfin?: SeriesProgressItem }) {
	return render(
		<ColorThemeProvider>
			<IncognitoProvider>
				<LibraryCard
					item={item}
					onToggleMonitor={vi.fn()}
					pending={false}
					seriesProgress={seriesProgress}
				/>
			</IncognitoProvider>
		</ColorThemeProvider>,
	);
}

describe("library card series progress evidence", () => {
	it("retains separate exact and lower-bound provider entries", () => {
		renderCard({
			plex: { status: "exact", watched: 4, total: 8, percent: 50, watchedSemantics: "exact" },
			jellyfin: {
				status: "partial",
				watched: 3,
				total: null,
				percent: null,
				watchedSemantics: "lower-bound",
			},
		});

		expect(screen.getByText("Plex")).toBeInTheDocument();
		expect(screen.getByText("4/8 (50%)")).toBeInTheDocument();
		expect(screen.getByText("Jellyfin")).toBeInTheDocument();
		expect(screen.getByText("At least 3 episodes watched")).toBeInTheDocument();
	});

	it("renders an explicit unknown provider state without inventing a percentage", () => {
		renderCard({
			plex: {
				status: "unknown",
				watched: null,
				total: null,
				percent: null,
				watchedSemantics: "unknown",
			},
		});

		expect(screen.getByText("Plex")).toBeInTheDocument();
		expect(screen.getByText("Watch status unknown")).toBeInTheDocument();
		expect(screen.queryByText(/%/)).not.toBeInTheDocument();
	});
});
