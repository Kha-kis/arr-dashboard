import type { PlexEvidenceSummary } from "@arr/shared";
import { render, screen } from "@testing-library/react";
import { beforeEach, describe, expect, it, vi } from "vitest";
import { ApiError } from "../../../../lib/api-client/base";

const state = vi.hoisted(() => ({
	plexLinks: {} as Record<string, unknown>,
}));

vi.mock("../../../../hooks/useFirstDayOfWeek", () => ({
	useFirstDayOfWeek: () => ({ weekStart: 0 }),
}));
vi.mock("../../../../hooks/api/useDashboard", () => ({
	useMultiInstanceCalendarQuery: () => ({
		data: [],
		isLoading: false,
		error: null,
		refetch: vi.fn(),
	}),
}));
vi.mock("../../../../hooks/api/useServicesQuery", () => ({
	useServicesQuery: () => ({ data: [{ id: "plex-1", service: "plex" }] }),
}));
vi.mock("../../hooks/use-calendar-state", () => ({
	useCalendarState: () => ({
		calendarStart: new Date("2026-08-01T00:00:00.000Z"),
		calendarEnd: new Date("2026-08-31T00:00:00.000Z"),
		monthStart: new Date("2026-08-01T00:00:00.000Z"),
		selectedDate: new Date("2026-08-20T00:00:00.000Z"),
		daysInView: [],
		filters: {
			includeUnmonitored: false,
			searchTerm: "",
			serviceFilter: "all",
			instanceFilter: "all",
		},
		handlePreviousMonth: vi.fn(),
		handleNextMonth: vi.fn(),
		handleGoToday: vi.fn(),
		setSelectedDate: vi.fn(),
		setSearchTerm: vi.fn(),
		setServiceFilter: vi.fn(),
		setInstanceFilter: vi.fn(),
		setIncludeUnmonitored: vi.fn(),
		resetFilters: vi.fn(),
	}),
}));
vi.mock("../../hooks/use-calendar-data", () => ({
	useCalendarData: () => ({
		eventsByDate: new Map(),
		serviceMap: new Map(),
		instanceOptions: [],
		filteredEvents: [{ tmdbId: 42, service: "radarr" }],
	}),
}));
vi.mock("../../hooks/use-calendar-plex-links", () => ({
	useCalendarPlexLinks: () => state.plexLinks,
}));
vi.mock("../calendar-header", () => ({ CalendarHeader: () => null }));
vi.mock("../calendar-filters", () => ({ CalendarFilters: () => null }));
vi.mock("../calendar-grid", () => ({ CalendarGrid: () => null }));
vi.mock("../calendar-event-list", () => ({ CalendarEventList: () => null }));

import { CalendarClient } from "../calendar-client";

beforeEach(() => {
	const evidence: PlexEvidenceSummary = {
		availability: "last-known",
		authority: "unavailable",
		attemptState: "error",
		publicationLevel: "unavailable",
		completeness: "unknown",
		reasonCodes: ["latest_attempt_failed"],
	};
	state.plexLinks = {
		plexUrlMap: new Map(),
		error: new ApiError("Plex cache evidence is unavailable", 503, {
			error: "Plex cache evidence is unavailable",
			evidence,
		} as never),
		evidence: undefined,
	};
});

describe("CalendarClient Plex evidence", () => {
	it("renders unavailable link coverage instead of silently treating the link as absent", () => {
		render(<CalendarClient />);

		expect(screen.getByText(/Plex values are unavailable/i)).toBeInTheDocument();
		expect(screen.getByText(/Calendar Plex links/i)).toBeInTheDocument();
		expect(screen.queryByText(/no Plex link|none|0 links/i)).not.toBeInTheDocument();
	});
});
