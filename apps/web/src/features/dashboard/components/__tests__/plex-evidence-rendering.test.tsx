import type { PlexEvidenceSummary } from "@arr/shared";
import { render, screen } from "@testing-library/react";
import { beforeEach, describe, expect, it, vi } from "vitest";
import { IncognitoProvider } from "../../../../contexts/IncognitoContext";
import { ApiError } from "../../../../lib/api-client/base";

class ResizeObserverStub {
	observe() {}
	unobserve() {}
	disconnect() {}
}
globalThis.ResizeObserver = ResizeObserverStub as unknown as typeof ResizeObserver;

const queryState = vi.hoisted(() => ({
	plexOnDeck: {} as Record<string, unknown>,
	plexRecentlyAdded: {} as Record<string, unknown>,
	jellyfinOnDeck: {} as Record<string, unknown>,
	jellyfinRecentlyAdded: {} as Record<string, unknown>,
}));

vi.mock("../../../../hooks/api/usePlex", () => ({
	useOnDeck: () => queryState.plexOnDeck,
	useRecentlyAdded: () => queryState.plexRecentlyAdded,
}));

vi.mock("../../../../hooks/api/useJellyfin", () => ({
	useJellyfinOnDeck: () => queryState.jellyfinOnDeck,
	useJellyfinRecentlyAdded: () => queryState.jellyfinRecentlyAdded,
}));

import { OnDeckWidget } from "../on-deck-widget";
import { RecentlyAddedWidget } from "../recently-added-widget";

const authoritativeEvidence: PlexEvidenceSummary = {
	availability: "current",
	authority: "authoritative",
	attemptState: "success",
	publicationLevel: "authoritative",
	completeness: "complete",
	reasonCodes: [],
};

function unavailableEvidence(attemptState: "error" | "in_progress"): PlexEvidenceSummary {
	return {
		availability: "last-known",
		authority: "unavailable",
		attemptState,
		publicationLevel: "unavailable",
		completeness: "unknown",
		reasonCodes: [
			attemptState === "in_progress" ? "latest_attempt_in_progress" : "latest_attempt_failed",
		],
	};
}

function failedQuery(evidence: PlexEvidenceSummary) {
	return {
		data: undefined,
		isLoading: false,
		isError: true,
		error: new ApiError("Plex cache evidence is unavailable", 503, {
			error: "Plex cache evidence is unavailable",
			evidence,
		} as never),
	};
}

function disabledQuery() {
	return { data: undefined, isLoading: false, isError: false, error: null };
}

function renderWithIncognito(node: React.ReactNode) {
	return render(<IncognitoProvider>{node}</IncognitoProvider>);
}

beforeEach(() => {
	queryState.plexOnDeck = disabledQuery();
	queryState.plexRecentlyAdded = disabledQuery();
	queryState.jellyfinOnDeck = disabledQuery();
	queryState.jellyfinRecentlyAdded = disabledQuery();
	localStorage.removeItem("arr-dashboard-incognito-mode");
});

describe("dashboard Plex evidence rendering", () => {
	it.each([
		["failed", "error" as const, /Plex values are unavailable/i],
		["in progress", "in_progress" as const, /Plex refresh in progress/i],
	])("renders the on-deck %s state without a false empty count", (_name, attemptState, text) => {
		queryState.plexOnDeck = failedQuery(unavailableEvidence(attemptState));

		renderWithIncognito(<OnDeckWidget hasPlexInstances={true} hasJellyfinInstances={false} />);

		expect(screen.getByText(text)).toBeInTheDocument();
		expect(screen.queryByText(/0 items? on deck/i)).not.toBeInTheDocument();
		expect(screen.queryByText(/nothing|none|unwatched/i)).not.toBeInTheDocument();
	});

	it("renders recently-added failure as unavailable instead of a false empty state", () => {
		queryState.plexRecentlyAdded = failedQuery(unavailableEvidence("error"));

		renderWithIncognito(
			<RecentlyAddedWidget hasPlexInstances={true} hasJellyfinInstances={false} />,
		);

		expect(screen.getByText(/Plex values are unavailable/i)).toBeInTheDocument();
		expect(screen.queryByText(/no recent additions|none|0 items?/i)).not.toBeInTheDocument();
	});

	it("keeps authoritative on-deck values unchanged", () => {
		queryState.plexOnDeck = {
			data: {
				items: [
					{
						tmdbId: 42,
						title: "Synthetic Movie",
						mediaType: "movie",
						sectionTitle: "Synthetic Library",
						instanceId: "plex-fixture",
						instanceName: "Synthetic Plex",
						ratingKey: "rating-42",
						thumb: null,
					},
				],
				evidence: authoritativeEvidence,
			},
			isLoading: false,
			isError: false,
			error: null,
		};

		renderWithIncognito(<OnDeckWidget hasPlexInstances={true} hasJellyfinInstances={false} />);

		expect(screen.getByText("Synthetic Movie")).toBeInTheDocument();
		expect(screen.getByText("1 item on deck")).toBeInTheDocument();
		expect(screen.queryByText(/unavailable|refresh in progress/i)).not.toBeInTheDocument();
	});
});
