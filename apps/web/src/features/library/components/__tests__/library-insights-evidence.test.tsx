import type { PlexEvidenceSummary } from "@arr/shared";
import { render, screen } from "@testing-library/react";
import { beforeEach, describe, expect, it, vi } from "vitest";
import { ApiError } from "../../../../lib/api-client/base";

const queryState = vi.hoisted(() => ({
	diskWaste: {} as Record<string, unknown>,
	watched: {} as Record<string, unknown>,
	requested: {} as Record<string, unknown>,
}));

vi.mock("next/navigation", () => ({
	useSearchParams: () => new URLSearchParams(),
}));
vi.mock("../../../../hooks/api/useDiskWasteInsights", () => ({
	useDiskWasteInsights: () => queryState.diskWaste,
}));
vi.mock("../../../../hooks/api/useWatchedMonitoredInsights", () => ({
	useWatchedMonitoredInsights: () => queryState.watched,
}));
vi.mock("../../../../hooks/api/useRequestedUnwatchedInsights", () => ({
	useRequestedUnwatchedInsights: () => queryState.requested,
}));
vi.mock("../../hooks/use-insight-dismissals", () => ({
	useInsightDismissals: () => ({ isDismissed: vi.fn(() => false), dismiss: vi.fn() }),
}));
vi.mock("../disk-waste-panel", () => ({ DiskWastePanel: () => null }));
vi.mock("../watched-monitored-panel", () => ({ WatchedMonitoredPanel: () => null }));
vi.mock("../requested-unwatched-panel", () => ({ RequestedUnwatchedPanel: () => null }));

import { LibraryInsightsSection } from "../library-insights-section";

function unavailableError(attemptState: "error" | "in_progress") {
	const evidence: PlexEvidenceSummary = {
		availability: "last-known",
		authority: "unavailable",
		attemptState,
		publicationLevel: "unavailable",
		completeness: "unknown",
		reasonCodes: [
			attemptState === "in_progress" ? "latest_attempt_in_progress" : "latest_attempt_failed",
		],
	};
	return new ApiError("Plex cache evidence is unavailable", 503, {
		error: "Plex cache evidence is unavailable",
		evidence,
	} as never);
}

beforeEach(() => {
	queryState.diskWaste = { data: undefined, isLoading: false, isError: false, error: null };
	queryState.watched = { data: undefined, isLoading: false, isError: false, error: null };
	queryState.requested = { data: undefined, isLoading: false, isError: false, error: null };
});

describe("LibraryInsightsSection Plex trust rendering", () => {
	it.each([
		["failed", "error" as const, /Plex values are unavailable/i],
		["refreshing", "in_progress" as const, /Plex refresh in progress/i],
	])("renders %s evidence without a false zero or unwatched claim", (_name, state, text) => {
		queryState.diskWaste = {
			data: undefined,
			isLoading: false,
			isError: true,
			error: unavailableError(state),
		};

		render(<LibraryInsightsSection />);

		expect(screen.getByText(text)).toBeInTheDocument();
		expect(screen.queryByText(/0 items? need attention/i)).not.toBeInTheDocument();
		expect(screen.queryByText(/never watched|unwatched|none/i)).not.toBeInTheDocument();
	});
});
