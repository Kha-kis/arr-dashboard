import type { DeviceAnalytics } from "@arr/shared";
import { cleanup, fireEvent, render, screen, within } from "@testing-library/react";
import { afterEach, describe, expect, it } from "vitest";
import { IncognitoProvider, useIncognitoMode } from "../../../../contexts/IncognitoContext";
import { ColorThemeProvider } from "../../../../providers/color-theme-provider";
import { DeviceChart } from "../device-chart";

afterEach(() => {
	cleanup();
	localStorage.removeItem("arr-dashboard-incognito-mode");
});

function IncognitoToggle() {
	const [incognito, setIncognito] = useIncognitoMode();
	return (
		<button type="button" onClick={() => setIncognito(!incognito)}>
			Toggle incognito
		</button>
	);
}

const initial: DeviceAnalytics = {
	platforms: [
		{ platform: "Host", sessions: 9, percent: 50 },
		{ platform: "One-Host", sessions: 6, percent: 33 },
		{ platform: "Desktop", sessions: 3, percent: 17 },
	],
	players: [
		{ player: "Player::Variant-One", platform: "Host", sessions: 9 },
		{ player: "Player::Variant", platform: "One-Host", sessions: 6 },
		{ player: "OtherPlayer", platform: "Desktop", sessions: 3 },
	],
	totalSessions: 18,
	measurement: {
		version: 1,
		status: "complete",
		observedSessions: 18,
		platformMeasuredSessions: 18,
		playerMeasuredSessions: 18,
		platformAxis: "platform",
		unverifiedPlatformSnapshots: 0,
		invalidDetailSnapshots: 0,
		configuredSources: 1,
		collection: {
			activeSnapshots: 1,
			idleSnapshots: 0,
			failedSnapshots: 0,
			legacySnapshots: 0,
			invalidSnapshots: 0,
		},
	},
};

const refreshed: DeviceAnalytics = {
	platforms: [
		{ platform: "Desktop", sessions: 7, percent: 58 },
		{ platform: "One-Host", sessions: 5, percent: 42 },
	],
	players: [
		{ player: "OtherPlayer", platform: "Desktop", sessions: 7 },
		{ player: "Player::Variant", platform: "One-Host", sessions: 5 },
	],
	totalSessions: 12,
	measurement: {
		version: 1,
		status: "complete",
		observedSessions: 12,
		platformMeasuredSessions: 12,
		playerMeasuredSessions: 12,
		platformAxis: "platform",
		unverifiedPlatformSnapshots: 0,
		invalidDetailSnapshots: 0,
		configuredSources: 1,
		collection: {
			activeSnapshots: 1,
			idleSnapshots: 0,
			failedSnapshots: 0,
			legacySnapshots: 0,
			invalidSnapshots: 0,
		},
	},
};

describe("DeviceChart refresh identity", () => {
	it.each(["plex", "jellyfin"] as const)(
		"removes the right %s player and updates counts when delimiter-containing devices reorder",
		(service) => {
			const chart = (data: DeviceAnalytics) => (
				<ColorThemeProvider>
					<IncognitoProvider>
						<DeviceChart data={data} isLoading={false} isError={false} service={service} />
					</IncognitoProvider>
				</ColorThemeProvider>
			);
			const { rerender } = render(chart(initial));
			expect(screen.getByTitle("Player::Variant-One")).toBeInTheDocument();
			expect(screen.getByTitle("Player::Variant")).toBeInTheDocument();

			rerender(chart(refreshed));

			expect(screen.queryByTitle("Player::Variant-One")).not.toBeInTheDocument();
			const players = screen.getByRole("heading", { name: "Top Players" }).parentElement!;
			expect(Array.from(players.querySelectorAll("span[title]"), (row) => row.textContent)).toEqual(
				["OtherPlayer", "Player::Variant"],
			);
			expect(screen.getByTitle("OtherPlayer").closest("li")).toHaveTextContent(
				/^OtherPlayerDesktop7$/,
			);
			expect(screen.getByTitle("Player::Variant").closest("li")).toHaveTextContent(
				/^Player::VariantOne-Host5$/,
			);
		},
	);

	it.each(["plex", "jellyfin"] as const)(
		"keeps %s platform counts and segments correct through a masked refresh and privacy toggle",
		(service) => {
			const chart = (data: DeviceAnalytics) => (
				<ColorThemeProvider>
					<IncognitoProvider>
						<IncognitoToggle />
						<DeviceChart data={data} isLoading={false} isError={false} service={service} />
					</IncognitoProvider>
				</ColorThemeProvider>
			);
			const { rerender, container } = render(chart(initial));
			fireEvent.click(screen.getByRole("button", { name: "Toggle incognito" }));
			rerender(chart(refreshed));

			expect(screen.getAllByText("Linux")).toHaveLength(4);
			for (const label of ["Host", "One-Host", "Desktop", "OtherPlayer", "Player::Variant"]) {
				expect(screen.queryByText(label)).not.toBeInTheDocument();
				expect(screen.queryByTitle(label)).not.toBeInTheDocument();
			}

			fireEvent.click(screen.getByRole("button", { name: "Toggle incognito" }));

			expect(screen.queryByText("Linux")).not.toBeInTheDocument();
			const legend = within(screen.getByRole("list", { name: "Platform labels" }));
			expect(legend.getByText("Desktop").parentElement).toHaveTextContent(/^Desktop7$/);
			expect(legend.getByText("One-Host").parentElement).toHaveTextContent(/^One-Host5$/);
			expect(container.querySelectorAll("circle")).toHaveLength(2);
		},
	);

	it("gives the platform distribution a generic accessible name", () => {
		render(
			<ColorThemeProvider>
				<IncognitoProvider>
					<DeviceChart data={initial} isLoading={false} isError={false} />
				</IncognitoProvider>
			</ColorThemeProvider>,
		);

		expect(screen.getByRole("img", { name: "Platform distribution" })).toBeInTheDocument();
	});
});
