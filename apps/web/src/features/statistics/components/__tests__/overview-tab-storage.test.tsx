/**
 * Render smoke for the Storage card transparency line (issue #486).
 *
 * The combined storage total de-duplicates disks shared by multiple *arr
 * instances. When more than one instance feeds the figure, the card must
 * explain the number as "N disks across M instances" so a large total reads
 * as inspectable rather than an unexplained sum.
 */

import { QueryClient, QueryClientProvider } from "@tanstack/react-query";
import { render, screen } from "@testing-library/react";
import type { ComponentProps, ReactNode } from "react";
import { describe, expect, it } from "vitest";
import { IncognitoProvider } from "../../../../contexts/IncognitoContext";
import { ColorThemeProvider } from "../../../../providers/color-theme-provider";
import { OverviewTab } from "../overview-tab";

const TB = 1024 ** 4;

function Wrapper({ children }: { children: ReactNode }) {
	const qc = new QueryClient({ defaultOptions: { queries: { retry: false } } });
	return (
		<QueryClientProvider client={qc}>
			<ColorThemeProvider>
				<IncognitoProvider>{children}</IncognitoProvider>
			</ColorThemeProvider>
		</QueryClientProvider>
	);
}

type Props = ComponentProps<typeof OverviewTab>;

const baseProps = (combinedDisk: Props["combinedDisk"]): Props =>
	({
		allHealthIssues: [],
		combinedDisk,
		sonarrRows: [],
		radarrRows: [],
		lidarrRows: [],
		readarrRows: [],
		prowlarrRows: [],
		sonarrTotals: { totalSeries: 0, downloadPercent: 0, missingEpisodes: 0, diskPercent: 0 },
		radarrTotals: { totalMovies: 0, downloadPercent: 0, missingMovies: 0, diskPercent: 0 },
		lidarrTotals: { totalArtists: 0, downloadPercent: 0, missingTracks: 0, diskPercent: 0 },
		readarrTotals: { totalAuthors: 0, downloadPercent: 0, missingBooks: 0, diskPercent: 0 },
		prowlarrTotals: { totalIndexers: 0, activeIndexers: 0, totalQueries: 0, grabRate: 0 },
		hasTautulli: false,
		onSwitchTab: () => {},
		// Only the fields the component actually reads are populated; cast through
		// unknown since the real totals types carry many more (untouched) fields.
	}) as unknown as Props;

describe("OverviewTab — Storage transparency line", () => {
	it("explains a de-duplicated total as 'N disks across M instances'", () => {
		render(
			<OverviewTab
				{...baseProps({
					diskTotal: 120 * TB,
					diskFree: 105 * TB,
					diskUsed: 15 * TB,
					diskUsagePercent: 12.5,
					diskCount: 1,
					instanceCount: 4,
				})}
			/>,
			{ wrapper: Wrapper },
		);

		// Singular "disk" for diskCount === 1, and the four contributing instances.
		expect(screen.getByText(/1 disk across 4 instances/)).toBeInTheDocument();
	});

	it("pluralizes 'disks' when more than one unique disk is counted", () => {
		render(
			<OverviewTab
				{...baseProps({
					diskTotal: 130 * TB,
					diskFree: 100 * TB,
					diskUsed: 30 * TB,
					diskUsagePercent: 23,
					diskCount: 2,
					instanceCount: 4,
				})}
			/>,
			{ wrapper: Wrapper },
		);

		expect(screen.getByText(/2 disks across 4 instances/)).toBeInTheDocument();
	});

	it("omits the breakdown when only one instance reports storage", () => {
		render(
			<OverviewTab
				{...baseProps({
					diskTotal: 10 * TB,
					diskFree: 4 * TB,
					diskUsed: 6 * TB,
					diskUsagePercent: 60,
					diskCount: 1,
					instanceCount: 1,
				})}
			/>,
			{ wrapper: Wrapper },
		);

		expect(screen.queryByText(/\d+ disks? across \d+ instances/)).not.toBeInTheDocument();
		expect(screen.getByText(/available/)).toBeInTheDocument();
	});

	it("renders the plain total when counts are absent (legacy/optional response)", () => {
		// diskCount/instanceCount are optional — an older backend (or any path
		// that omits them) must still render "of X available" and never crash on
		// `undefined` inside the breakdown template.
		render(
			<OverviewTab
				{...baseProps({
					diskTotal: 10 * TB,
					diskFree: 4 * TB,
					diskUsed: 6 * TB,
					diskUsagePercent: 60,
				})}
			/>,
			{ wrapper: Wrapper },
		);

		expect(screen.queryByText(/\d+ disks? across \d+ instances/)).not.toBeInTheDocument();
		expect(screen.getByText(/available/)).toBeInTheDocument();
	});
});
