import type {
	PlexEvidenceSummary,
	ProviderObservationAvailability,
	ProviderObservationStatusEnvelope,
} from "@arr/shared";
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
vi.mock("../disk-waste-panel", () => ({
	DiskWastePanel: ({ queryData }: { queryData?: { data?: { items?: unknown[] } } }) =>
		queryData?.data?.items?.length ? <div>Disk fixture panel</div> : null,
}));
vi.mock("../watched-monitored-panel", () => ({
	WatchedMonitoredPanel: ({ queryData }: { queryData?: { data?: { items?: unknown[] } } }) =>
		queryData?.data?.items?.length ? <div>Watched fixture panel</div> : null,
}));
vi.mock("../requested-unwatched-panel", () => ({
	RequestedUnwatchedPanel: ({ queryData }: { queryData?: { data?: { items?: unknown[] } } }) =>
		queryData?.data?.items?.length ? <div>Requested fixture panel</div> : null,
}));

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

function providerStatus(
	availability: ProviderObservationAvailability,
): ProviderObservationStatusEnvelope {
	return {
		availability,
		sources: [
			{
				instanceId: "private-provider-instance",
				service: "jellyfin",
				cacheType: "jellyfin",
				status: {
					availability,
					evidence: "unknown",
					observedAt: null,
					ageSeconds: null,
					latestAttempt: "successful",
					reasonCodes: ["unknown-failure"],
				},
			},
		],
	};
}

beforeEach(() => {
	queryState.diskWaste = { data: undefined, isLoading: false, isError: false, error: null };
	queryState.watched = { data: undefined, isLoading: false, isError: false, error: null };
	queryState.requested = { data: undefined, isLoading: false, isError: false, error: null };
});

describe("LibraryInsightsSection Plex trust rendering", () => {
	it("hides absent and all-current empty insights without a generic notice", () => {
		queryState.diskWaste = {
			data: { data: { items: [], hasPlexData: false, hasWatchData: false } },
			isLoading: false,
			isError: false,
			error: null,
		};
		queryState.watched = {
			data: {
				data: { items: [], hasPlexData: false, hasWatchData: false },
				providerStatus: providerStatus("current"),
			},
			isLoading: false,
			isError: false,
			error: null,
		};
		queryState.requested = {
			data: { data: { items: [], hasPlexData: false, hasWatchData: false, hasSeerrData: false } },
			isLoading: false,
			isError: false,
			error: null,
		};

		const { container } = render(<LibraryInsightsSection />);

		expect(container).toBeEmptyDOMElement();
	});

	it.each([
		["last-known", providerStatus("last-known"), /Showing last-known media-server data/i],
		["partial", providerStatus("partial"), /Media-server data is unavailable/i],
		["unavailable", providerStatus("unavailable"), /Media-server data is unavailable/i],
	] as const)("renders a fail-closed %s empty status shell", (_name, status, notice) => {
		queryState.diskWaste = {
			data: {
				data: { items: [], hasPlexData: false, hasWatchData: false },
				providerStatus: status,
			},
			isLoading: false,
			isError: false,
			error: null,
		};

		render(<LibraryInsightsSection />);

		expect(screen.getByText("Library Insights")).toBeInTheDocument();
		expect(screen.getByText(notice)).toBeInTheDocument();
		expect(screen.queryByText(/0 items? need attention/i)).not.toBeInTheDocument();
		expect(screen.queryByText(/nothing|none|never watched|unwatched/i)).not.toBeInTheDocument();
	});

	it("resolves mixed unknown insight statuses to unavailable and preserves safe returned rows", () => {
		queryState.diskWaste = {
			data: {
				data: {
					items: [
						{
							arrItemId: 101,
							instanceId: "private-disk-instance",
							instanceName: "Private Disk Instance",
							service: "radarr",
							title: "Private Disk Title",
							year: null,
							sizeOnDisk: 1,
							addedDaysAgo: 31,
							monitored: true,
							qualityProfileName: null,
						},
					],
					totalWastedBytes: 1,
					hasPlexData: true,
					hasWatchData: true,
				},
				providerStatus: providerStatus("last-known"),
			},
			isLoading: false,
			isError: false,
			error: null,
		};
		queryState.watched = {
			data: {
				data: { items: [], hasPlexData: true, hasWatchData: true },
				providerStatus: providerStatus("unavailable"),
			},
			isLoading: false,
			isError: false,
			error: null,
		};

		render(<LibraryInsightsSection />);

		expect(screen.getByText(/Media-server data is unavailable/i)).toBeInTheDocument();
		expect(screen.getByText(/1 item need attention/i)).toBeInTheDocument();
		expect(screen.getByText("Disk fixture panel")).toBeInTheDocument();
	});

	it.each([
		["failed", "error" as const, /Showing last-known Plex values/i],
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
		if (state === "error") {
			expect(
				screen.getByText(/No Plex rows are being shown; absence remains unknown/i),
			).toBeInTheDocument();
		}
		expect(screen.queryByText(/0 items? need attention/i)).not.toBeInTheDocument();
		expect(screen.queryByText(/never watched|unwatched|none/i)).not.toBeInTheDocument();
	});

	it("keeps Plex and fail-closed provider notices independent", () => {
		queryState.diskWaste = {
			data: {
				data: { items: [], hasPlexData: false, hasWatchData: false },
				providerStatus: providerStatus("partial"),
			},
			isLoading: false,
			isError: true,
			error: unavailableError("error"),
		};

		render(<LibraryInsightsSection />);

		expect(screen.getByText(/Showing last-known Plex values/i)).toBeInTheDocument();
		expect(
			screen.getByText(/No Plex rows are being shown; absence remains unknown/i),
		).toBeInTheDocument();
		expect(screen.getByText(/Media-server data is unavailable/i)).toBeInTheDocument();
	});
});
