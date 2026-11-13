import type { SampledActivityCollection } from "@arr/shared";
import { cleanup, fireEvent, render, screen } from "@testing-library/react";
import { afterEach, describe, expect, it } from "vitest";
import { IncognitoProvider, useIncognitoMode } from "../../../../contexts/IncognitoContext";
import { ColorThemeProvider } from "../../../../providers/color-theme-provider";
import { TopMediaChart } from "../top-media-chart";
import { WatchHistoryWidget } from "../watch-history-widget";

const collection = {
	activeSnapshots: 0,
	idleSnapshots: 0,
	failedSnapshots: 0,
	legacySnapshots: 0,
	invalidSnapshots: 0,
};
afterEach(() => {
	cleanup();
	localStorage.removeItem("arr-dashboard-incognito-mode");
});

function panel(family: "history" | "top", measurement?: SampledActivityCollection) {
	return render(
		<ColorThemeProvider>
			<IncognitoProvider>
				{family === "history" ? (
					<WatchHistoryWidget
						data={{ events: [], measurement }}
						isLoading={false}
						isError={false}
					/>
				) : (
					<TopMediaChart
						data={{ items: [], measurement }}
						isLoading={false}
						isError={false}
						mediaType="movie"
					/>
				)}
			</IncognitoProvider>
		</ColorThemeProvider>,
	);
}

describe.each(["history", "top"] as const)("%s collection state presentation", (family) => {
	it.each([
		{ label: /no configured.*sources/i, configuredSources: 0, coverage: collection },
		{ label: /no observations.*scheduler/i, configuredSources: 1, coverage: collection },
		{
			label: /successful idle.*observations/i,
			configuredSources: 1,
			coverage: { ...collection, idleSnapshots: 1 },
		},
		{
			label: /collection failed.*settings/i,
			configuredSources: 1,
			coverage: { ...collection, failedSnapshots: 1 },
		},
		{
			label: /invalid.*evidence.*settings/i,
			configuredSources: 1,
			coverage: { ...collection, invalidSnapshots: 1 },
		},
	])(
		"distinguishes $label without claiming ordinary no history",
		({ label, configuredSources, coverage }) => {
			panel(family, { version: 1, configuredSources, collection: coverage });
			expect(screen.getByText(label)).toBeInTheDocument();
			expect(screen.queryByText(/No Watch History Yet|No Top Movies Yet/i)).not.toBeInTheDocument();
		},
	);
	it("does not infer native collection coverage from an old response", () => {
		panel(family);
		expect(screen.getByText(/legacy.*unverified.*collection/i)).toBeInTheDocument();
	});

	it.each(["activeSnapshots", "idleSnapshots"] as const)(
		"reports incomplete coverage when %s and failed samples coexist",
		(successfulCategory) => {
			panel(family, {
				version: 1,
				configuredSources: 1,
				collection: { ...collection, [successfulCategory]: 3, failedSnapshots: 1 },
			});
			expect(
				screen.getByText(/no matching activity.*successful samples.*some samples failed/i),
			).toBeInTheDocument();
			expect(screen.getByText(/1 failed/)).toBeInTheDocument();
			expect(
				screen.queryByText(/check source settings and retry collection/i),
			).not.toBeInTheDocument();
		},
	);
});

function TogglePrivacy() {
	const [active, setActive] = useIncognitoMode();
	return (
		<button type="button" onClick={() => setActive(!active)}>
			Toggle privacy
		</button>
	);
}

it.each(["plays", "popularity"] as const)(
	"retains unidentified observations without presenting false zero %s",
	(metric) => {
		render(
			<ColorThemeProvider>
				<IncognitoProvider>
					<TopMediaChart
						data={{
							measurement: {
								version: 1,
								configuredSources: 1,
								collection: { ...collection, legacySnapshots: 2 },
							},
							items: [
								{
									title: "Synthetic unmatched title",
									mediaType: "movie",
									playCount: 0,
									distinctUserCount: 0,
									unattributedSessions: 2,
									unidentifiedPlaybackSessions: 2,
									totalDurationMinutes: 10,
									lastWatchedAt: "2026-10-05T12:00:00Z",
								},
							],
						}}
						metric={metric}
						mediaType="movie"
						isLoading={false}
						isError={false}
					/>
				</IncognitoProvider>
			</ColorThemeProvider>,
		);
		expect(screen.getByText("Synthetic unmatched title")).toBeInTheDocument();
		expect(screen.getByText("Unknown")).toBeInTheDocument();
		expect(screen.getByText(/2.*unattributed.*2.*unidentified playback/i)).toBeInTheDocument();
		expect(screen.getByText(/sample-weighted.*not.*verified.*playback/i)).toBeInTheDocument();
	},
);

it("shows known playback subtotals alongside unidentified coverage rather than hiding useful data", () => {
	render(
		<ColorThemeProvider>
			<IncognitoProvider>
				<TopMediaChart
					data={{
						measurement: {
							version: 1,
							configuredSources: 1,
							collection: { ...collection, activeSnapshots: 1, legacySnapshots: 1 },
						},
						items: [
							{
								title: "Synthetic partial title",
								mediaType: "movie",
								playCount: 2,
								distinctUserCount: 1,
								unattributedSessions: 3,
								unidentifiedPlaybackSessions: 3,
								totalDurationMinutes: 25,
								lastWatchedAt: "2026-10-05T12:00:00Z",
							},
						],
					}}
					mediaType="movie"
					isLoading={false}
					isError={false}
				/>
			</IncognitoProvider>
		</ColorThemeProvider>,
	);
	expect(screen.getByText(/known plays/i).parentElement).toHaveTextContent("2");
	expect(screen.getByText(/3.*unattributed.*3.*unidentified playback/i)).toBeInTheDocument();
});

it("does not certify legacy API method/device labels and masks retained History text", () => {
	render(
		<ColorThemeProvider>
			<IncognitoProvider>
				<TogglePrivacy />
				<WatchHistoryWidget
					data={{
						events: [
							{
								user: "Synthetic private viewer",
								title: "Synthetic private title",
								platform: "Synthetic fallback device",
								videoDecision: "direct play",
								timestamp: "2026-10-05T12:00:00Z",
							},
						],
					}}
					isLoading={false}
					isError
				/>
			</IncognitoProvider>
		</ColorThemeProvider>,
	);
	expect(screen.getByText(/device unknown/i)).toBeInTheDocument();
	expect(screen.getByText(/video method unknown/i)).toBeInTheDocument();
	expect(screen.queryByText("Synthetic fallback device")).not.toBeInTheDocument();
	expect(screen.queryByText("direct play")).not.toBeInTheDocument();
	expect(screen.getByText("Synthetic private title")).toBeInTheDocument();
	fireEvent.click(screen.getByRole("button", { name: "Toggle privacy" }));
	expect(screen.queryByText("Synthetic private title")).not.toBeInTheDocument();
	expect(screen.queryByText("Synthetic private viewer")).not.toBeInTheDocument();
});
