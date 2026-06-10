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

const baseProps = (
	combinedDisk: Omit<Props["combinedDisk"], "disks"> &
		Partial<Pick<Props["combinedDisk"], "disks">>,
): Props =>
	({
		allHealthIssues: [],
		// Default `disks` to [] for fixtures that don't care about the breakdown;
		// individual cases can still override by supplying it.
		combinedDisk: { disks: [], ...combinedDisk },
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
		hasPlex: false,
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

	it("does NOT show '(media only)' for dedup-only breakdowns (v2.21.0 review regression)", () => {
		// The issue-#486 canonical case: 4 *arrs on 1 shared array, no root-folder
		// exclusions. The breakdown carries 1 "media" + 3 "deduplicated" entries,
		// so disks.length (4) > diskCount (1) purely from dedup. The "(media
		// only)" label must NOT fire — it's gated on at least one
		// "no-matching-root-folder" exclusion, not on a raw count comparison.
		const sharedDisk = { path: "/data", totalSpace: 120 * TB, freeSpace: 105 * TB };
		render(
			<OverviewTab
				{...baseProps({
					diskTotal: 120 * TB,
					diskFree: 105 * TB,
					diskUsed: 15 * TB,
					diskUsagePercent: 12.5,
					diskCount: 1,
					instanceCount: 4,
					disks: [
						{ ...sharedDisk, includedInRollup: true, reason: "media" },
						{ ...sharedDisk, includedInRollup: false, reason: "deduplicated" },
						{ ...sharedDisk, includedInRollup: false, reason: "deduplicated" },
						{ ...sharedDisk, includedInRollup: false, reason: "deduplicated" },
					],
				})}
			/>,
			{ wrapper: Wrapper },
		);

		expect(screen.queryByText(/media only/)).not.toBeInTheDocument();
		expect(screen.getByText(/1 disk across 4 instances/)).toBeInTheDocument();
	});

	it("shows '(media only)' when the root-folder filter excluded non-media disks", () => {
		// The issue-#495 case: container `/` and `/config` excluded, `/data` kept.
		render(
			<OverviewTab
				{...baseProps({
					diskTotal: 131 * TB,
					diskFree: 37 * TB,
					diskUsed: 94 * TB,
					diskUsagePercent: 71.8,
					diskCount: 1,
					instanceCount: 1,
					disks: [
						{
							path: "/data",
							totalSpace: 131 * TB,
							freeSpace: 37 * TB,
							includedInRollup: true,
							reason: "media",
						},
						{
							path: "/",
							totalSpace: 1.5 * TB,
							freeSpace: 0.5 * TB,
							includedInRollup: false,
							reason: "no-matching-root-folder",
						},
						{
							path: "/config",
							totalSpace: 0.5 * TB,
							freeSpace: 0.4 * TB,
							includedInRollup: false,
							reason: "no-matching-root-folder",
						},
					],
				})}
			/>,
			{ wrapper: Wrapper },
		);

		expect(screen.getByText(/1 of 3 disks \(media only\)/)).toBeInTheDocument();
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
