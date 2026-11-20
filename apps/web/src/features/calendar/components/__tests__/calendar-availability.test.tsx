import type { CalendarItem, MultiInstanceCalendarResponse } from "@arr/shared";
import { QueryClient, QueryClientProvider } from "@tanstack/react-query";
import { act, cleanup, fireEvent, render, screen, waitFor } from "@testing-library/react";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { IncognitoProvider } from "../../../../contexts/IncognitoContext";
import { ColorThemeProvider } from "../../../../providers/color-theme-provider";
import { CalendarClient } from "../calendar-client";

const today = new Date().toISOString().split("T")[0]!;
const event: CalendarItem = {
	id: 31,
	title: "Synthetic known schedule",
	service: "radarr",
	type: "movie",
	airDate: today,
	tmdbId: 42,
	instanceId: "north",
	instanceName: "Synthetic North",
};
const source: MultiInstanceCalendarResponse["instances"][number] = {
	instanceId: "north",
	instanceName: "Synthetic North",
	service: "radarr",
	data: [],
	availability: "available",
	reason: null,
	rejectedItemCount: 0,
};
let payload: unknown;
let status: number;
let calendarReads: number;
let hasPlex: boolean;
let plexAvailable: boolean;
let failedPlexTargets: Set<number>;
let lastKnownPlex: boolean;
let genericPlexError: boolean;
let plexTargets: Array<{ ids: string; types: string }>;
const clients: QueryClient[] = [];
const json = (value: unknown, code = 200) =>
	new Response(JSON.stringify(value), {
		status: code,
		headers: { "content-type": "application/json" },
	});
function show() {
	const client = new QueryClient({ defaultOptions: { queries: { retry: false, gcTime: 0 } } });
	clients.push(client);
	return render(
		<QueryClientProvider client={client}>
			<ColorThemeProvider>
				<IncognitoProvider>
					<CalendarClient />
				</IncognitoProvider>
			</ColorThemeProvider>
		</QueryClientProvider>,
	);
}
beforeEach(() => {
	localStorage.clear();
	status = 200;
	calendarReads = 0;
	hasPlex = false;
	plexAvailable = false;
	failedPlexTargets = new Set();
	lastKnownPlex = false;
	genericPlexError = false;
	plexTargets = [];
	payload = { instances: [source], aggregated: [], totalCount: 0, availability: "available" };
	vi.spyOn(globalThis, "fetch").mockImplementation(async (input) => {
		const path = String(input);
		if (path.startsWith("/api/dashboard/calendar?")) {
			calendarReads++;
			return json(payload, status);
		}
		if (path === "/api/services")
			return json({
				services: [
					{
						id: "north",
						service: "radarr",
						label: "Synthetic North",
						enabled: true,
						baseUrl: "http://synthetic.invalid",
					},
					...(hasPlex
						? [{ id: "plex", service: "plex", label: "Synthetic Plex", enabled: true }]
						: []),
				],
			});
		if (path === "/api/plex/identity")
			return json({
				servers: [
					{
						instanceId: "plex",
						instanceName: "Synthetic Plex",
						machineId: "synthetic-machine",
						version: "synthetic",
						friendlyName: "Synthetic",
						platform: "synthetic",
					},
				],
			});
		if (path.startsWith("/api/plex/watch-enrichment?")) {
			const params = new URL(path, "http://synthetic.invalid").searchParams;
			const ids = params.get("tmdbIds")!;
			const types = params.get("types")!;
			plexTargets.push({ ids, types });
			if (ids.split(",").length > 200) return json({ error: "Max 200 items per request" }, 400);
			if (ids.split(",").some((id) => !Number.isSafeInteger(Number(id)) || Number(id) <= 0))
				return json({ error: "All tmdbIds must be positive integers" }, 400);
			if (plexAvailable && !ids.split(",").some((id) => failedPlexTargets.has(Number(id))))
				return json({
					items: Object.fromEntries(
						ids.split(",").map((id, index) => [
							`${types.split(",")[index]}:${id}`,
							{
								lastWatchedAt: null,
								watchCount: null,
								watchCountSemantics: "unknown",
								watchedByUsers: [],
								onDeck: null,
								userRating: null,
								source: "plex",
								ratingKey: id === "42" ? "movie-key" : `movie-key-${id}`,
								instanceId: "plex",
								collections: [],
								labels: [],
							},
						]),
					),
					evidence: lastKnownPlex
						? {
								availability: "last-known",
								authority: "unavailable",
								attemptState: "error",
								publicationLevel: "positive-only",
								completeness: "partial",
								reasonCodes: ["latest_attempt_failed"],
							}
						: {
								availability: "current",
								authority: "authoritative",
								attemptState: "success",
								publicationLevel: "authoritative",
								completeness: "complete",
								reasonCodes: [],
							},
				});
			if (genericPlexError) return json({ error: "Synthetic generic failure" }, 503);
			return json(
				{
					error: "Synthetic Plex unavailable",
					evidence: {
						availability: "last-known",
						authority: "unavailable",
						attemptState: "error",
						publicationLevel: "unavailable",
						completeness: "unknown",
						reasonCodes: ["latest_attempt_failed"],
					},
				},
				503,
			);
		}
		throw new Error("Unexpected synthetic read");
	});
});
afterEach(() => {
	cleanup();
	for (const client of clients.splice(0)) client.clear();
	vi.restoreAllMocks();
});

describe("real CalendarClient availability and normal query flow", () => {
	it("retains last-known evidence guidance and links after an unstructured refresh failure", async () => {
		hasPlex = true;
		plexAvailable = true;
		lastKnownPlex = true;
		payload = {
			instances: [{ ...source, data: [event] }],
			aggregated: [event],
			totalCount: 1,
			availability: "available",
		};
		show();
		await screen.findByRole("link", { name: "Plex" });
		expect(screen.getByText(/Showing last-known Plex values/i)).toBeInTheDocument();
		plexAvailable = false;
		genericPlexError = true;
		fireEvent.click(screen.getByRole("button", { name: "Refresh calendar" }));
		await screen.findByText(/Some Plex links could not be verified/i);
		expect(screen.getByRole("link", { name: "Plex" })).toBeInTheDocument();
		expect(screen.getByText(/Showing last-known Plex values/i)).toBeInTheDocument();
		expect(
			screen.getByText(/Confirmed Plex rows are shown; omitted rows remain unknown/i),
		).toBeInTheDocument();
	});
	it("keeps 200 healthy links visible during a sibling failure and restores the missing link through Refresh", async () => {
		hasPlex = true;
		plexAvailable = true;
		failedPlexTargets.add(201);
		const events = Array.from({ length: 201 }, (_, index) => ({
			...event,
			id: index + 1,
			tmdbId: index + 1,
			title: `Synthetic schedule ${index + 1}`,
		}));
		payload = {
			instances: [{ ...source, data: events }],
			aggregated: events,
			totalCount: 201,
			availability: "available",
		};
		show();
		// All201 real rows remain rendered; allow bounded settling under the full worker pool.
		await screen.findByText(/Some Plex links could not be verified/i, {}, { timeout: 5_000 });
		expect(screen.getAllByText("Plex", { selector: "a" })).toHaveLength(200);
		expect(screen.getByText("201 items scheduled")).toBeInTheDocument();
		expect(screen.getByText(/missing links are unknown/i)).not.toHaveTextContent(
			/Synthetic|north|201|movie-key/,
		);
		expect(
			screen.queryByText(/Calendar coverage is incomplete|Calendar sources are unavailable/i),
		).not.toBeInTheDocument();
		expect(plexTargets.map((target) => target.ids.split(",").length)).toEqual([200, 1]);
		failedPlexTargets.clear();
		fireEvent.click(screen.getByRole("button", { name: "Refresh calendar" }));
		await waitFor(() => expect(screen.getAllByText("Plex", { selector: "a" })).toHaveLength(201), {
			timeout: 5_000,
		});
		await waitFor(
			() =>
				expect(
					screen.queryByText(/Some Plex links could not be verified/i),
				).not.toBeInTheDocument(),
			{ timeout: 5_000 },
		);
		expect(screen.queryByText(/Showing last-known Plex values/i)).not.toBeInTheDocument();
		expect(calendarReads).toBe(2);
		expect(plexTargets.map((target) => target.ids.split(",").length)).toEqual([200, 1, 200, 1]);
	}, 15_000);
	it("preserves schedules and valid Plex links while explaining invalid external metadata generically", async () => {
		hasPlex = true;
		plexAvailable = true;
		const invalid = { ...event, id: 32, title: "Synthetic unmatchable schedule", tmdbId: 0 };
		payload = {
			instances: [{ ...source, data: [event, invalid] }],
			aggregated: [event, invalid],
			totalCount: 2,
			availability: "available",
		};
		show();
		const plexLink = await screen.findByRole("link", { name: "Plex" });
		expect(plexLink).toHaveAttribute(
			"href",
			"https://app.plex.tv/desktop/#!/server/synthetic-machine/details?key=%2Flibrary%2Fmetadata%2Fmovie-key",
		);
		expect(screen.getAllByText(event.title!)).toHaveLength(2);
		expect(screen.getAllByText(invalid.title!)).toHaveLength(2);
		const notice = screen.getByRole("status");
		expect(notice).toHaveTextContent(/lack a valid external ID/i);
		expect(notice).toHaveTextContent(/check.*metadata.*Sonarr or Radarr/i);
		expect(notice).toHaveTextContent(/schedule data remains available/i);
		expect(notice).not.toHaveTextContent(/Synthetic|north|42|movie-key|synthetic-machine/);
		expect(
			screen.queryByText(
				/Calendar coverage is incomplete|Calendar sources are unavailable|Plex values are unavailable|No scheduled items/i,
			),
		).not.toBeInTheDocument();
		expect(plexTargets).toEqual([{ ids: "42", types: "movie" }]);
	});
	it("clears metadata guidance and restores a link after calendar metadata is repaired", async () => {
		hasPlex = true;
		plexAvailable = true;
		const invalid = { ...event, tmdbId: 0 };
		payload = {
			instances: [{ ...source, data: [invalid] }],
			aggregated: [invalid],
			totalCount: 1,
			availability: "available",
		};
		show();
		expect(await screen.findByRole("status")).toHaveTextContent(/lack a valid external ID/i);
		expect(screen.getAllByText(event.title!)).toHaveLength(2);
		expect(plexTargets).toEqual([]);
		payload = {
			instances: [{ ...source, data: [event] }],
			aggregated: [event],
			totalCount: 1,
			availability: "available",
		};
		fireEvent.click(screen.getByRole("button", { name: "Refresh calendar" }));
		expect(await screen.findByRole("link", { name: "Plex" })).toBeInTheDocument();
		expect(screen.queryByRole("status")).not.toBeInTheDocument();
		expect(screen.getAllByText(event.title!)).toHaveLength(2);
		expect(plexTargets).toEqual([{ ids: "42", types: "movie" }]);
	});
	it("keeps missing metadata quiet without configured Plex", async () => {
		const invalid = { ...event, tmdbId: 0 };
		payload = {
			instances: [{ ...source, data: [invalid] }],
			aggregated: [invalid],
			totalCount: 1,
			availability: "available",
		};
		show();
		await screen.findAllByText(event.title!);
		expect(screen.queryByRole("status")).not.toBeInTheDocument();
		expect(plexTargets).toEqual([]);
	});
	it("shows ordinary empty state only for verified available sources", async () => {
		show();
		expect(await screen.findByText("No scheduled items for this date")).toBeInTheDocument();
		expect(screen.queryByRole("alert")).not.toBeInTheDocument();
	});
	it("retains partial positives and coverage despite search/date emptiness", async () => {
		payload = {
			instances: [
				{
					...source,
					data: [event],
					availability: "partial",
					reason: "invalid-items",
					rejectedItemCount: 1,
				},
			],
			aggregated: [event],
			totalCount: 1,
			availability: "partial",
		};
		show();
		expect(await screen.findByText(/Calendar coverage is incomplete/i)).toBeInTheDocument();
		expect(screen.getAllByText(event.title!)).toHaveLength(2);
		fireEvent.change(screen.getByPlaceholderText(/Search/i), { target: { value: "no match" } });
		expect(screen.queryByText(event.title!)).not.toBeInTheDocument();
		expect(screen.getByText(/Calendar coverage is incomplete/i)).toBeInTheDocument();
		expect(screen.queryByText("No scheduled items for this date")).not.toBeInTheDocument();
	});
	it("has a distinct unavailable state with no verified-empty claim", async () => {
		payload = {
			instances: [{ ...source, availability: "unavailable", reason: "provider-unavailable" }],
			aggregated: [],
			totalCount: 0,
			availability: "unavailable",
		};
		show();
		expect(await screen.findByText(/Calendar sources are unavailable/i)).toBeInTheDocument();
		expect(screen.queryByText("No scheduled items for this date")).not.toBeInTheDocument();
		expect(screen.getByRole("button", { name: "Refresh calendar" })).toBeEnabled();
	});
	it("shows separate setup guidance for no configured sources", async () => {
		payload = { instances: [], aggregated: [], totalCount: 0, availability: "not-configured" };
		show();
		expect(await screen.findByText(/No calendar sources match/i)).toBeInTheDocument();
		expect(screen.queryByText("No scheduled items for this date")).not.toBeInTheDocument();
	});
	it.each(["available", "partial"] as const)(
		"labels retained %s data last-known after failed refetch, then recovers through the focusable native refresh button",
		async (availability) => {
			payload = {
				instances: [
					{
						...source,
						data: [event],
						availability,
						reason: availability === "partial" ? "invalid-items" : null,
						rejectedItemCount: availability === "partial" ? 1 : 0,
					},
				],
				aggregated: [event],
				totalCount: 1,
				availability,
			};
			show();
			await screen.findAllByText(event.title!);
			status = 503;
			const refresh = screen.getByRole("button", { name: "Refresh calendar" });
			refresh.focus();
			expect(refresh).toHaveFocus();
			expect(refresh.tagName).toBe("BUTTON");
			fireEvent.click(refresh);
			expect(await screen.findByText(/Showing last-known calendar events/i)).toBeInTheDocument();
			expect(screen.getAllByText(event.title!)).toHaveLength(2);
			status = 200;
			payload = {
				instances: [{ ...source, data: [event] }],
				aggregated: [event],
				totalCount: 1,
				availability: "available",
			};
			fireEvent.click(refresh);
			await waitFor(() =>
				expect(screen.queryByText(/Showing last-known calendar events/i)).not.toBeInTheDocument(),
			);
			expect(screen.queryByText(/Calendar coverage is incomplete/i)).not.toBeInTheDocument();
			expect(calendarReads).toBe(3);
		},
	);
	it("initial read failure never publishes verified emptiness and recovery clears it", async () => {
		status = 503;
		show();
		expect(await screen.findByText(/Unable to verify calendar data/i)).toBeInTheDocument();
		expect(screen.queryByText("No scheduled items for this date")).not.toBeInTheDocument();
		status = 200;
		await act(async () =>
			fireEvent.click(screen.getByRole("button", { name: "Refresh calendar" })),
		);
		expect(await screen.findByText("No scheduled items for this date")).toBeInTheDocument();
		expect(screen.queryByText(/Unable to verify calendar data/i)).not.toBeInTheDocument();
	});
	it("optional Plex link failure does not change healthy ARR availability", async () => {
		hasPlex = true;
		payload = {
			instances: [{ ...source, data: [event] }],
			aggregated: [event],
			totalCount: 1,
			availability: "available",
		};
		show();
		expect(await screen.findByText(/Showing last-known Plex values/i)).toBeInTheDocument();
		expect(screen.getAllByText(event.title!)).toHaveLength(2);
		expect(
			screen.queryByText(
				/Calendar coverage is incomplete|Showing last-known calendar events|Calendar sources are unavailable/i,
			),
		).not.toBeInTheDocument();
		plexAvailable = true;
		fireEvent.click(screen.getByRole("button", { name: "Refresh calendar" }));
		expect(await screen.findByRole("link", { name: "Plex" })).toBeInTheDocument();
		expect(screen.queryByText(/Showing last-known Plex values/i)).not.toBeInTheDocument();
		expect(screen.queryByRole("status")).not.toBeInTheDocument();
		expect(screen.getAllByText(event.title!)).toHaveLength(2);
		plexAvailable = false;
		fireEvent.click(screen.getByRole("button", { name: "Refresh calendar" }));
		await screen.findByText(/Showing last-known Plex values/i);
		expect(screen.getByRole("link", { name: "Plex" })).toBeInTheDocument();
		expect(screen.getByText(/Some Plex links could not be verified/i)).toHaveTextContent(
			/Previously verified links remain available/i,
		);
		plexAvailable = true;
		fireEvent.click(screen.getByRole("button", { name: "Refresh calendar" }));
		await waitFor(() =>
			expect(screen.queryByText(/Some Plex links could not be verified/i)).not.toBeInTheDocument(),
		);
		expect(screen.queryByText(/Showing last-known Plex values/i)).not.toBeInTheDocument();
	});
	it("keeps source warnings through search but follows service selection", async () => {
		payload = {
			instances: [
				source,
				{
					...source,
					instanceId: "south",
					service: "sonarr",
					availability: "unavailable",
					reason: "provider-unavailable",
				},
			],
			aggregated: [],
			totalCount: 0,
			availability: "partial",
		};
		show();
		await screen.findByText(/Calendar coverage is incomplete/i);
		fireEvent.click(screen.getByRole("button", { name: "Radarr" }));
		expect(screen.queryByText(/Calendar coverage is incomplete/i)).not.toBeInTheDocument();
		expect(screen.getByText("No scheduled items for this date")).toBeInTheDocument();
		fireEvent.click(screen.getByRole("button", { name: "Sonarr" }));
		expect(screen.getByText(/Calendar sources are unavailable/i)).toBeInTheDocument();
		fireEvent.click(screen.getByRole("button", { name: "Readarr" }));
		expect(screen.getByText(/No calendar sources match/i)).toBeInTheDocument();
	});
	it("preserves incognito masking for retained positive schedules", async () => {
		localStorage.setItem("arr-dashboard-incognito-mode", "true");
		payload = {
			instances: [
				{
					...source,
					data: [event],
					availability: "partial",
					reason: "invalid-items",
					rejectedItemCount: 1,
				},
			],
			aggregated: [event],
			totalCount: 1,
			availability: "partial",
		};
		show();
		await screen.findByText(/Calendar coverage is incomplete/i);
		expect(screen.queryByText(event.title!)).not.toBeInTheDocument();
		expect(screen.getByText("1 item scheduled")).toBeInTheDocument();
	});
});
