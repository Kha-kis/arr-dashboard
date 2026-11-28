import type { LibraryEpisodesResponse } from "@arr/shared";
import { act, fireEvent, render, screen, within } from "@testing-library/react";
import { beforeEach, describe, expect, it, vi } from "vitest";
import { IncognitoProvider } from "../../../../contexts/IncognitoContext";
import { ColorThemeProvider } from "../../../../providers/color-theme-provider";

const mutations = vi.hoisted(() => ({
	search: vi.fn(),
	monitor: vi.fn(),
}));

const data: LibraryEpisodesResponse = {
	episodes: [
		{
			id: 101,
			seriesId: 42,
			seasonNumber: 3,
			episodeNumber: 1,
			title: "Synthetic downloaded episode with a long title",
			airDate: "2026-10-01T12:00:00.000Z",
			runtime: 48,
			finaleType: "season",
			hasFile: true,
			monitored: true,
			episodeFileId: 501,
			episodeFile: {
				relativePath: "Synthetic series/Season 03/episode-one.mkv",
				quality: "WEB-1080p",
				releaseGroup: "SyntheticGroup",
				size: 1073741824,
				dateAdded: "2026-10-02T12:00:00.000Z",
				languages: ["English", "Spanish"],
				videoCodec: "h265",
				audioCodec: "EAC3",
				resolution: "1080p",
				videoDynamicRange: "HDR10",
				customFormats: ["Synthetic format"],
				customFormatScore: 25,
			},
		},
		{
			id: 102,
			seriesId: 42,
			seasonNumber: 3,
			episodeNumber: 2,
			title: "Synthetic missing episode",
			hasFile: false,
			monitored: false,
		},
		{
			id: 103,
			seriesId: 42,
			seasonNumber: 3,
			episodeNumber: 3,
			hasFile: false,
		},
	],
};

vi.mock("../../../../hooks/api/useLibrary", () => ({
	useEpisodesQuery: () => ({ data, isLoading: false, isError: false }),
	useLibraryEpisodeSearchMutation: () => ({ mutateAsync: mutations.search }),
	useLibraryEpisodeMonitorMutation: () => ({ mutateAsync: mutations.monitor }),
}));

import { SeasonEpisodeList } from "../season-episode-list";

function renderEpisodes() {
	return render(
		<ColorThemeProvider>
			<IncognitoProvider>
				<SeasonEpisodeList instanceId="synthetic-sonarr" seriesId="42" seasonNumber={3} />
			</IncognitoProvider>
		</ColorThemeProvider>,
	);
}

// These preserve the populated row's behavior; JSDOM does not establish layout geometry.
describe("season episode row control preservation", () => {
	beforeEach(() => {
		localStorage.clear();
		vi.resetAllMocks();
	});

	it("keeps every status, action, and downloaded file detail available", () => {
		renderEpisodes();

		for (const text of [
			"E1",
			"E2",
			"E3",
			"Synthetic downloaded episode with a long title",
			"Synthetic missing episode",
			"TBA",
			"Downloaded",
			"Monitored",
			"Unmonitored",
			"season",
			"48m",
			"WEB-1080p",
			"— SyntheticGroup",
			"HDR10",
			"h265 / EAC3",
			"English, Spanish",
			"1.0 GB",
			"Score: 25",
			"Synthetic format",
			"Synthetic series/Season 03/episode-one.mkv",
		]) {
			expect(screen.getByText(text)).toBeVisible();
		}
		expect(screen.getByText("1080p")).toBeVisible();
		expect(
			screen.getByText(new Date("2026-10-01T12:00:00.000Z").toLocaleDateString()),
		).toBeVisible();
		expect(screen.getAllByText("Missing")).toHaveLength(2);
		expect(screen.getAllByRole("button")).toHaveLength(6);
		expect(screen.getByTitle("Unmonitor episode")).toBeEnabled();
		expect(screen.getAllByTitle("Monitor episode")).toHaveLength(2);
		expect(screen.getAllByTitle("Search for episode")).toHaveLength(3);
		for (const button of screen.getAllByRole("button")) {
			expect(button).toBeVisible();
			expect(button).toBeEnabled();
		}
	});

	it("searches only the selected episode and disables only its search while pending", async () => {
		let finishSearch!: () => void;
		mutations.search.mockImplementation(
			() =>
				new Promise<void>((resolve) => {
					finishSearch = resolve;
				}),
		);
		renderEpisodes();
		const searches = screen.getAllByTitle("Search for episode");
		fireEvent.click(searches[1]!);

		expect(mutations.search).toHaveBeenCalledExactlyOnceWith({
			instanceId: "synthetic-sonarr",
			episodeIds: [102],
		});
		expect(searches[1]).toBeDisabled();
		expect(searches[0]).toBeEnabled();
		expect(searches[2]).toBeEnabled();
		expect(screen.getAllByTitle("Monitor episode")[0]).toBeEnabled();

		await act(async () => finishSearch());
		expect(searches[1]).toBeEnabled();
	});

	it.each([
		{ episodeId: 101, episodeNumber: 1, monitored: false },
		{ episodeId: 102, episodeNumber: 2, monitored: true },
		{ episodeId: 103, episodeNumber: 3, monitored: true },
	])(
		"preserves monitor arguments and pending state for episode $episodeId",
		async ({ episodeId, episodeNumber, monitored }) => {
			let finishMonitor!: () => void;
			mutations.monitor.mockImplementation(
				() =>
					new Promise<void>((resolve) => {
						finishMonitor = resolve;
					}),
			);
			renderEpisodes();
			const row = screen.getByText(`E${episodeNumber}`).closest("div.rounded-lg");
			expect(row).not.toBeNull();
			const controls = within(row as HTMLElement);
			const monitor = controls.getByTitle(monitored ? "Monitor episode" : "Unmonitor episode");
			fireEvent.click(monitor);

			expect(mutations.monitor).toHaveBeenCalledExactlyOnceWith({
				instanceId: "synthetic-sonarr",
				seriesId: "42",
				episodeIds: [episodeId],
				monitored,
			});
			expect(monitor).toBeDisabled();
			expect(controls.getByTitle("Search for episode")).toBeEnabled();
			expect(
				screen.getAllByRole("button").filter((button) => button.hasAttribute("disabled")),
			).toHaveLength(1);

			await act(async () => finishMonitor());
			expect(monitor).toBeEnabled();
		},
	);
});
