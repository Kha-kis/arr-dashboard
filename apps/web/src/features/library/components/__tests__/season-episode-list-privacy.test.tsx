import { render, screen } from "@testing-library/react";
import { beforeEach, describe, expect, it, vi } from "vitest";
import { IncognitoProvider } from "../../../../contexts/IncognitoContext";
import { getLinuxIsoName, getLinuxSavePath } from "../../../../lib/incognito";
import { ColorThemeProvider } from "../../../../providers/color-theme-provider";

vi.mock("../../../../hooks/api/useLibrary", () => ({
	useEpisodesQuery: () => ({
		data: {
			episodes: [
				{
					id: 1,
					episodeNumber: 1,
					title: "Private episode title",
					hasFile: true,
					monitored: true,
					episodeFile: { relativePath: "Private series/Private episode title.mkv", size: 1024 },
				},
			],
		},
		isLoading: false,
		isError: false,
	}),
	useLibraryEpisodeSearchMutation: () => ({ mutateAsync: vi.fn() }),
	useLibraryEpisodeMonitorMutation: () => ({ mutateAsync: vi.fn() }),
}));

import { SeasonEpisodeList } from "../season-episode-list";

describe("season episode detail privacy", () => {
	beforeEach(() => localStorage.clear());
	it.each([false, true])("renders populated episode details with incognito=%s", (incognito) => {
		localStorage.setItem("arr-dashboard-incognito-mode", String(incognito));
		const { container } = render(
			<ColorThemeProvider>
				<IncognitoProvider>
					<SeasonEpisodeList instanceId="synthetic" seriesId={1} seasonNumber={1} />
				</IncognitoProvider>
			</ColorThemeProvider>,
		);
		expect(screen.getByText("E1")).toBeInTheDocument();
		expect(screen.getByText("Downloaded")).toBeInTheDocument();
		if (incognito) {
			expect(container.innerHTML).not.toContain("Private episode title");
			expect(container.innerHTML).not.toContain("Private series");
			expect(screen.getByText(getLinuxIsoName("Private episode title"))).toBeInTheDocument();
			expect(
				screen.getByText(getLinuxSavePath("Private series/Private episode title.mkv")),
			).toBeInTheDocument();
		} else {
			expect(screen.getByText("Private episode title")).toBeInTheDocument();
			expect(screen.getByText("Private series/Private episode title.mkv")).toBeInTheDocument();
		}
	});
});
