import type { PlexEvidenceSummary, ProviderObservationStatusEnvelope } from "@arr/shared";
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

const plexPartialEvidence: PlexEvidenceSummary = {
	availability: "current",
	authority: "positive-only",
	attemptState: "partial",
	publicationLevel: "positive-only",
	completeness: "partial",
	reasonCodes: ["latest_attempt_partial"],
};

const plexLastKnownEvidence: PlexEvidenceSummary = {
	availability: "last-known",
	authority: "authoritative",
	attemptState: "success",
	publicationLevel: "authoritative",
	completeness: "complete",
	reasonCodes: ["published_generation_stale"],
};

const jellyfinLastKnownStatus: ProviderObservationStatusEnvelope = {
	availability: "last-known",
	sources: [],
};

const jellyfinPartialStatus: ProviderObservationStatusEnvelope = {
	availability: "partial",
	sources: [],
};

const jellyfinCurrentStatus: ProviderObservationStatusEnvelope = {
	availability: "current",
	sources: [],
};

const jellyfinUnavailableStatus: ProviderObservationStatusEnvelope = {
	availability: "unavailable",
	sources: [],
};

const jellyfinOnDeckStatusWithUnavailableWatchCount: ProviderObservationStatusEnvelope = {
	availability: "current",
	sources: [
		{
			instanceId: "jellyfin-fixture",
			service: "jellyfin",
			cacheType: "jellyfin",
			status: {
				availability: "current",
				evidence: "complete",
				observedAt: "2026-09-03T00:00:00.000Z",
				ageSeconds: 10,
				latestAttempt: "successful",
				reasonCodes: [],
				domains: [
					...(["library-inventory", "mapping", "on-deck"] as const).map((domain) => ({
						domain,
						availability: "current" as const,
						evidence: "complete" as const,
						valueSemantics: "exact" as const,
						observedAt: "2026-09-03T00:00:00.000Z",
						reasonCodes: [],
					})),
					{
						domain: "watch-count",
						availability: "unavailable",
						evidence: "unknown",
						valueSemantics: "unknown",
						observedAt: null,
						reasonCodes: ["provider-unavailable"],
					},
				],
			},
		},
	],
};

function jellyfinItem(overrides: Record<string, unknown> = {}) {
	return {
		tmdbId: 84,
		title: "Synthetic Jellyfin Movie",
		mediaType: "movie",
		libraryName: "Synthetic Jellyfin Library",
		instanceId: "jellyfin-fixture",
		instanceName: "Synthetic Jellyfin",
		jellyfinId: "jellyfin-item-84",
		thumb: null,
		addedAt: "2026-09-03T00:00:00.000Z",
		...overrides,
	};
}

function plexItem(overrides: Record<string, unknown> = {}) {
	return {
		tmdbId: 42,
		title: "Synthetic Plex Movie",
		mediaType: "movie",
		sectionTitle: "Synthetic Plex Library",
		instanceId: "plex-fixture",
		instanceName: "Synthetic Plex",
		ratingKey: "rating-42",
		thumb: null,
		addedAt: "2026-09-03T00:00:00.000Z",
		...overrides,
	};
}

function unavailableEvidence(attemptState: "error" | "in_progress"): PlexEvidenceSummary {
	return {
		availability: attemptState === "in_progress" ? "last-known" : "unavailable",
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
		[
			"partial",
			plexPartialEvidence,
			/Showing current mapped data/i,
			/Some unsupported items were excluded/i,
		],
		[
			"last-known",
			plexLastKnownEvidence,
			/Showing last-known media-server data/i,
			/latest observation may be stale/i,
		],
	] as const)(
		"renders %s Plex rows with qualified On Deck coverage",
		(_name, evidence, notice, detail) => {
			queryState.plexOnDeck = {
				data: { items: [plexItem()], evidence },
				isLoading: false,
				isError: false,
				error: null,
			};

			renderWithIncognito(<OnDeckWidget hasPlexInstances={true} hasJellyfinInstances={false} />);

			expect(screen.getByText("Synthetic Plex Movie")).toBeInTheDocument();
			expect(screen.getByText(notice)).toBeInTheDocument();
			expect(screen.getByText(detail)).toBeInTheDocument();
			expect(
				screen.getByText(/Showing available items; provider coverage is bounded/i),
			).toBeInTheDocument();
			expect(screen.queryByText(/1 item on deck/i)).not.toBeInTheDocument();
		},
	);

	it.each([
		["partial", plexPartialEvidence, /Showing current mapped data/i],
		["last-known", plexLastKnownEvidence, /Showing last-known media-server data/i],
	] as const)("keeps zero-row %s Plex evidence truthful", (_name, evidence, notice) => {
		queryState.plexOnDeck = {
			data: { items: [], evidence },
			isLoading: false,
			isError: false,
			error: null,
		};

		renderWithIncognito(<OnDeckWidget hasPlexInstances={true} hasJellyfinInstances={false} />);

		expect(screen.getByText(notice)).toBeInTheDocument();
		expect(screen.getByRole("status")).toBeInTheDocument();
		expect(screen.queryByText(/confirmed Plex rows are shown/i)).not.toBeInTheDocument();
	});

	it("renders partial Plex Recently Added rows with qualified coverage", () => {
		queryState.plexRecentlyAdded = {
			data: { items: [plexItem()], evidence: plexPartialEvidence },
			isLoading: false,
			isError: false,
			error: null,
		};

		renderWithIncognito(
			<RecentlyAddedWidget hasPlexInstances={true} hasJellyfinInstances={false} />,
		);

		expect(screen.getByText("Synthetic Plex Movie")).toBeInTheDocument();
		expect(screen.getByText(/Showing current mapped data/i)).toBeInTheDocument();
	});

	it.each([
		["failed", "error" as const, /Media-server refresh needs attention/i],
		["in progress", "in_progress" as const, /Media-server data is being collected/i],
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

		expect(screen.getByText(/Media-server refresh needs attention/i)).toBeInTheDocument();
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

	it.each([
		["last-known", jellyfinLastKnownStatus],
		["partial", jellyfinPartialStatus],
		["unavailable", jellyfinUnavailableStatus],
	] as const)(
		"shows a bounded notice for empty Jellyfin on-deck %s data",
		(_name, providerStatus) => {
			queryState.jellyfinOnDeck = {
				data: { items: [], providerStatus },
				isLoading: false,
				isError: false,
				error: null,
			};

			renderWithIncognito(<OnDeckWidget hasPlexInstances={false} hasJellyfinInstances={true} />);

			expect(screen.getByRole("status")).toBeInTheDocument();
			expect(screen.queryByText(/0 items? on deck|nothing|none/i)).not.toBeInTheDocument();
		},
	);

	it("uses generic unavailable copy for an empty Jellyfin transport error", () => {
		queryState.jellyfinOnDeck = {
			data: undefined,
			isLoading: false,
			isError: true,
			error: new Error("private upstream URL and token"),
		};

		renderWithIncognito(<OnDeckWidget hasPlexInstances={false} hasJellyfinInstances={true} />);

		expect(screen.getByText(/Media-server data is unavailable/i)).toBeInTheDocument();
		expect(screen.queryByText(/private upstream URL and token/i)).not.toBeInTheDocument();
	});

	it.each([
		[
			"last-known",
			jellyfinLastKnownStatus,
			/Showing last-known media-server data/i,
			"Showing available items; provider coverage is bounded",
		],
		[
			"partial",
			jellyfinPartialStatus,
			/Media-server data is incomplete/i,
			"Showing available items; provider coverage is bounded",
		],
		[
			"unavailable",
			jellyfinUnavailableStatus,
			/Media-server data is unavailable/i,
			"Showing available items; provider coverage is bounded",
		],
	] as const)(
		"keeps %s Jellyfin On Deck rows without a complete count",
		(_name, providerStatus, notice, qualifiedSubtitle) => {
			queryState.jellyfinOnDeck = {
				data: { items: [jellyfinItem()], providerStatus },
				isLoading: false,
				isError: false,
				error: null,
			};

			renderWithIncognito(<OnDeckWidget hasPlexInstances={false} hasJellyfinInstances={true} />);

			expect(screen.getByText("Synthetic Jellyfin Movie")).toBeInTheDocument();
			expect(screen.getByText(notice)).toBeInTheDocument();
			expect(screen.getByText(qualifiedSubtitle)).toBeInTheDocument();
			expect(screen.queryByText(/1 item on deck/i)).not.toBeInTheDocument();
		},
	);

	it("keeps current Jellyfin rows and existing On Deck count behavior without a notice", () => {
		queryState.jellyfinOnDeck = {
			data: { items: [jellyfinItem()], providerStatus: jellyfinCurrentStatus },
			isLoading: false,
			isError: false,
			error: null,
		};

		renderWithIncognito(<OnDeckWidget hasPlexInstances={false} hasJellyfinInstances={true} />);

		expect(screen.getByText("Synthetic Jellyfin Movie")).toBeInTheDocument();
		expect(screen.getByText("1 item on deck")).toBeInTheDocument();
		expect(
			screen.queryByText(/Media-server data is incomplete|unavailable|last-known/i),
		).not.toBeInTheDocument();
	});

	it("keeps On Deck usable when unrelated Jellyfin watch count evidence is unavailable", () => {
		queryState.jellyfinOnDeck = {
			data: {
				items: [jellyfinItem()],
				providerStatus: jellyfinOnDeckStatusWithUnavailableWatchCount,
			},
			isLoading: false,
			isError: false,
			error: null,
		};

		renderWithIncognito(<OnDeckWidget hasPlexInstances={false} hasJellyfinInstances={true} />);

		expect(screen.getByText("Synthetic Jellyfin Movie")).toBeInTheDocument();
		expect(screen.getByText("1 item on deck")).toBeInTheDocument();
		expect(screen.queryByRole("status")).not.toBeInTheDocument();
	});

	it.each([
		["last-known", jellyfinLastKnownStatus, /Showing last-known media-server data/i],
		["partial", jellyfinPartialStatus, /Media-server data is incomplete/i],
		["unavailable", jellyfinUnavailableStatus, /Media-server data is unavailable/i],
	] as const)(
		"keeps %s Recently Added rows with a Jellyfin notice",
		(_name, providerStatus, notice) => {
			queryState.jellyfinRecentlyAdded = {
				data: { items: [jellyfinItem()], providerStatus },
				isLoading: false,
				isError: false,
				error: null,
			};

			renderWithIncognito(
				<RecentlyAddedWidget hasPlexInstances={false} hasJellyfinInstances={true} />,
			);

			expect(screen.getByText("Synthetic Jellyfin Movie")).toBeInTheDocument();
			expect(screen.getByText(notice)).toBeInTheDocument();
		},
	);

	it("shows a bounded card for empty Recently Added Jellyfin data", () => {
		queryState.jellyfinRecentlyAdded = {
			data: { items: [], providerStatus: jellyfinUnavailableStatus },
			isLoading: false,
			isError: false,
			error: null,
		};

		renderWithIncognito(
			<RecentlyAddedWidget hasPlexInstances={false} hasJellyfinInstances={true} />,
		);

		expect(screen.getByText("Recently Added")).toBeInTheDocument();
		expect(screen.getByText(/Media-server data is unavailable/i)).toBeInTheDocument();
		expect(screen.queryByText(/no recent additions|none|0 items?/i)).not.toBeInTheDocument();
	});

	it("deduplicates Plex and Jellyfin notices without hiding rows", () => {
		queryState.plexOnDeck = failedQuery(unavailableEvidence("error"));
		queryState.jellyfinOnDeck = {
			data: { items: [jellyfinItem()], providerStatus: jellyfinPartialStatus },
			isLoading: false,
			isError: false,
			error: null,
		};

		renderWithIncognito(<OnDeckWidget hasPlexInstances={true} hasJellyfinInstances={true} />);

		expect(screen.getByText("Synthetic Jellyfin Movie")).toBeInTheDocument();
		expect(screen.getAllByRole("status")).toHaveLength(1);
		expect(screen.getByText(/Media-server refresh needs attention/i)).toBeInTheDocument();
		expect(screen.queryByText(/Media-server data is incomplete/i)).not.toBeInTheDocument();
	});

	it.each([
		[
			"On Deck",
			<OnDeckWidget key="on-deck" hasPlexInstances={true} hasJellyfinInstances={false} />,
		],
		[
			"Recently Added",
			<RecentlyAddedWidget
				key="recently-added"
				hasPlexInstances={true}
				hasJellyfinInstances={false}
			/>,
		],
	] as const)("does not show a disabled Jellyfin error in the %s Plex card", (_name, widget) => {
		queryState.plexOnDeck = failedQuery(unavailableEvidence("error"));
		queryState.plexRecentlyAdded = failedQuery(unavailableEvidence("error"));
		queryState.jellyfinOnDeck = {
			data: undefined,
			isLoading: false,
			isError: true,
			error: new Error("disabled provider failure"),
		};
		queryState.jellyfinRecentlyAdded = {
			data: undefined,
			isLoading: false,
			isError: true,
			error: new Error("disabled provider failure"),
		};

		renderWithIncognito(widget);

		expect(screen.getByText(/Media-server refresh needs attention/i)).toBeInTheDocument();
		expect(screen.queryByText(/Media-server data is unavailable/i)).not.toBeInTheDocument();
	});
});
