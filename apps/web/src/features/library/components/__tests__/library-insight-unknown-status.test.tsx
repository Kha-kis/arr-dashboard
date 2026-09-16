import { render, screen } from "@testing-library/react";
import { afterEach, beforeAll, describe, expect, it, vi } from "vitest";
import { IncognitoProvider } from "../../../../contexts/IncognitoContext";
import type { DiskWasteResponse } from "../../../../hooks/api/useDiskWasteInsights";
import type { RequestedUnwatchedResponse } from "../../../../hooks/api/useRequestedUnwatchedInsights";
import { ColorThemeProvider } from "../../../../providers/color-theme-provider";

vi.mock("../../../../hooks/api/useLibrary", () => ({
	useLibraryMonitorMutation: () => ({ mutateAsync: vi.fn() }),
}));

import { DiskWastePanel } from "../disk-waste-panel";
import { RequestedUnwatchedPanel } from "../requested-unwatched-panel";

function renderPrivate(children: React.ReactNode) {
	localStorage.setItem("arr-dashboard-incognito-mode", "true");
	return render(
		<ColorThemeProvider>
			<IncognitoProvider>{children}</IncognitoProvider>
		</ColorThemeProvider>,
	);
}

afterEach(() => {
	localStorage.clear();
	vi.clearAllMocks();
});

beforeAll(() => {
	HTMLElement.prototype.scrollIntoView = vi.fn();
});

describe("library insight unknown status", () => {
	it("keeps disk candidates visible without an unmonitor action or false waste claim", () => {
		const response: DiskWasteResponse = {
			success: true,
			data: {
				items: [],
				unknownItems: [
					{
						arrItemId: 101,
						instanceId: "private-instance",
						instanceName: "Private Server",
						service: "radarr",
						title: "Private Movie",
						year: 2025,
						sizeOnDisk: 2 * 1024 * 1024 * 1024,
						addedDaysAgo: 45,
						monitored: true,
						qualityProfileName: null,
						watchState: "unknown",
					},
				],
				totalWastedBytes: null,
				hasPlexData: false,
				hasWatchData: false,
				watchStatus: "unavailable",
				limited: false,
			},
		};

		renderPrivate(<DiskWastePanel queryData={response} autoExpand />);

		expect(screen.getAllByText(/Watch status unknown/).length).toBeGreaterThan(0);
		expect(screen.queryByText("Private Movie")).not.toBeInTheDocument();
		expect(screen.queryByText(/unwatched|wasted/i)).not.toBeInTheDocument();
		expect(screen.queryByRole("button", { name: "Unmonitor" })).not.toBeInTheDocument();
	});

	it("keeps requested facts and requester private when watch status is unknown", () => {
		const response: RequestedUnwatchedResponse = {
			success: true,
			data: {
				items: [],
				unknownItems: [
					{
						arrItemId: 202,
						instanceId: "private-instance",
						instanceName: "Private Server",
						service: "sonarr",
						title: "Private Series",
						year: 2024,
						sizeOnDisk: 1,
						addedDaysAgo: 12,
						requestedBy: "private-user",
						requestedAt: "2026-01-01T00:00:00.000Z",
						watchState: "unknown",
					},
				],
				hasSeerrData: true,
				hasPlexData: false,
				hasWatchData: false,
				watchStatus: "unavailable",
				requestStatus: "complete",
				limited: false,
			},
		};

		renderPrivate(<RequestedUnwatchedPanel queryData={response} autoExpand />);

		expect(screen.getAllByText(/Watch status unknown/).length).toBeGreaterThan(0);
		expect(screen.getByText(/Available\s+12\s*d ago/)).toBeInTheDocument();
		expect(screen.queryByText("Private Series")).not.toBeInTheDocument();
		expect(screen.queryByText("private-user")).not.toBeInTheDocument();
		expect(screen.queryByText(/never watched/i)).not.toBeInTheDocument();
	});
});
