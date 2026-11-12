import type { LibraryItem, SeriesProgressItem } from "@arr/shared";
import { render, screen } from "@testing-library/react";
import { describe, expect, it, vi } from "vitest";
import { IncognitoProvider } from "../../../../contexts/IncognitoContext";
import { ColorThemeProvider } from "../../../../providers/color-theme-provider";
import { LibraryCard } from "../library-card";
import { PosterImage } from "../poster-image";

vi.mock("../poster-image", () => ({ PosterImage: vi.fn(() => null) }));
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

function renderCard(
	seriesProgress: { plex?: SeriesProgressItem; jellyfin?: SeriesProgressItem },
	seedingSummary?: { trackerCount: number; topHosts: string[]; complete: boolean },
) {
	return render(
		<ColorThemeProvider>
			<IncognitoProvider>
				<LibraryCard
					item={item}
					onToggleMonitor={vi.fn()}
					pending={false}
					seriesProgress={seriesProgress}
					seedingSummary={seedingSummary}
				/>
			</IncognitoProvider>
		</ColorThemeProvider>,
	);
}

describe("library card series progress evidence", () => {
	it("opts card artwork into native lazy loading", () => {
		renderCard({});
		expect(PosterImage).toHaveBeenLastCalledWith(
			expect.objectContaining({ loading: "lazy" }),
			undefined,
		);
	});

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

	it("helps resolve a Jellyfin series without a verified match", () => {
		renderCard({
			jellyfin: {
				status: "unknown",
				watched: null,
				total: null,
				percent: null,
				watchedSemantics: "unknown",
				reason: "no-verified-match",
			},
		});

		expect(screen.getByText("No verified Jellyfin match")).toBeVisible();
		expect(
			screen.getByText("Check that the series is in Jellyfin and verify its TMDB match."),
		).toBeVisible();
		expect(screen.queryByText(/%/)).not.toBeInTheDocument();
	});

	it("shows Jellyfin progress for matched episodes and the recorded observation time", () => {
		const observedAt = "2026-11-11T12:34:56.000Z";
		const jellyfin = {
			status: "mapped",
			watched: 0,
			total: 8,
			percent: 0,
			watchedSemantics: "matched",
			observedAt,
		} satisfies SeriesProgressItem;
		const { unmount } = renderCard({ jellyfin });

		expect(screen.getByText("Jellyfin")).toBeVisible();
		expect(screen.getByText("0/8 matched episodes watched (0%)")).toBeVisible();
		const time = screen.getByText(new Date(observedAt).toLocaleString());
		expect(time).toBeVisible();
		expect(time).toHaveAttribute("datetime", observedAt);
		expect(time.tagName).toBe("TIME");
		expect(time.parentElement).toHaveTextContent(/Observed/);
		unmount();

		const { container } = renderCard({ jellyfin: { ...jellyfin, observedAt: "invalid" } });
		expect(screen.getByText("0/8 matched episodes watched (0%)")).toBeVisible();
		expect(screen.getByText("Observation time unavailable")).toBeVisible();
		expect(container.querySelector("time")).toBeNull();
	});

	it("labels a partial tracker count as a lower bound", () => {
		renderCard({}, { trackerCount: 2, topHosts: ["tracker.invalid"], complete: false });
		expect(screen.getByTitle("At least 2 trackers observed")).toBeInTheDocument();
		expect(screen.queryByTitle("Seeding at 2 trackers")).not.toBeInTheDocument();
	});
});
