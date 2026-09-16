import { fireEvent, render, screen } from "@testing-library/react";
import { afterEach, describe, expect, it, vi } from "vitest";
import { IncognitoProvider } from "../../../../contexts/IncognitoContext";
import type { WatchedMonitoredResponse } from "../../../../hooks/api/useWatchedMonitoredInsights";
import { ColorThemeProvider } from "../../../../providers/color-theme-provider";
import { WatchedMonitoredPanel } from "../watched-monitored-panel";

const mutate = vi.hoisted(() => vi.fn());
vi.mock("../../../../hooks/api/useLibrary", () => ({
	useLibraryMonitorMutation: () => ({ mutateAsync: mutate }),
}));

afterEach(() => {
	localStorage.removeItem("arr-dashboard-incognito-mode");
	vi.clearAllMocks();
});

describe("watched-monitored observation display", () => {
	it("labels lower-bound plays and masks identifying fields in incognito mode", () => {
		localStorage.setItem("arr-dashboard-incognito-mode", "true");
		render(
			<ColorThemeProvider>
				<IncognitoProvider>
					<WatchedMonitoredPanel
						queryData={{
							success: true,
							data: {
								hasPlexData: true,
								hasWatchData: true,
								items: [
									{
										arrItemId: 1,
										instanceId: "fixture-instance",
										instanceName: "Private Server",
										service: "radarr",
										title: "Private Title",
										year: 2020,
										sizeOnDisk: 1,
										watchCount: 3,
										watchCountSemantics: "lower-bound",
										lastWatchedAt: null,
										qualityProfileName: null,
									},
								],
							},
						}}
					/>
				</IncognitoProvider>
			</ColorThemeProvider>,
		);
		fireEvent.click(screen.getByRole("button", { name: /1 watched item still monitored/i }));
		expect(screen.getByText("≥ 3 plays")).toBeInTheDocument();
		expect(screen.getByText(/this list may be incomplete/i)).toBeInTheDocument();
		expect(screen.queryByText("Private Title")).not.toBeInTheDocument();
		expect(screen.queryByText(/Private Server|Last watched/)).not.toBeInTheDocument();
		expect(mutate).not.toHaveBeenCalled();
		expect(screen.queryByRole("button", { name: "Unmonitor" })).not.toBeInTheDocument();
	});

	it("removes the action when refreshed evidence is partial or its mapped target changes", () => {
		const data: WatchedMonitoredResponse = {
			success: true,
			data: {
				hasPlexData: true,
				hasWatchData: true,
				items: [
					{
						arrItemId: 1,
						instanceId: "first-instance",
						instanceName: "Server",
						service: "radarr",
						title: "Title",
						year: null,
						sizeOnDisk: 1,
						watchCount: 3,
						watchCountSemantics: "exact",
						lastWatchedAt: null,
						qualityProfileName: null,
					},
				],
			},
		};
		const panel = (response: WatchedMonitoredResponse) => (
			<ColorThemeProvider>
				<IncognitoProvider>
					<WatchedMonitoredPanel queryData={response} />
				</IncognitoProvider>
			</ColorThemeProvider>
		);
		const view = render(panel(data));
		fireEvent.click(screen.getByRole("button", { name: /1 watched item still monitored/i }));
		expect(screen.getByRole("button", { name: "Unmonitor" })).toBeInTheDocument();
		for (const instanceId of ["first-instance", "changed-shared-library-instance"]) {
			for (const semantics of ["lower-bound", undefined] as const) {
				view.rerender(
					panel({
						...data,
						data: {
							...data.data,
							items: [{ ...data.data.items[0]!, instanceId, watchCountSemantics: semantics }],
						},
					}),
				);
				expect(screen.queryByRole("button", { name: "Unmonitor" })).not.toBeInTheDocument();
				expect(mutate).not.toHaveBeenCalled();
			}
		}
	});
});
