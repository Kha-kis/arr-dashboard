import type { ProviderNativeInventoryResponse, ServiceInstanceSummary } from "@arr/shared";
import { fireEvent, render, screen, waitFor } from "@testing-library/react";
import { beforeEach, describe, expect, it, vi } from "vitest";
import { IncognitoProvider } from "../../../../contexts/IncognitoContext";

const state = vi.hoisted(() => ({
	incognito: false,
	data: undefined as ProviderNativeInventoryResponse | undefined,
	isLoading: false,
	isFetching: false,
	isError: false,
	servicesSuccess: true,
	servicesLoading: false,
	servicesError: false,
	servicesRefetch: vi.fn(),
	refetch: vi.fn(),
	services: [] as ServiceInstanceSummary[],
	hookCalls: [] as Array<Record<string, unknown>>,
}));

vi.mock("../../../../components/ui", () => ({
	Badge: ({ children, ...props }: React.HTMLAttributes<HTMLSpanElement>) => (
		<span {...props}>{children}</span>
	),
	Button: ({ children, ...props }: React.ButtonHTMLAttributes<HTMLButtonElement>) => (
		<button {...props}>{children}</button>
	),
	Card: ({ children, ...props }: React.HTMLAttributes<HTMLDivElement>) => (
		<div {...props}>{children}</div>
	),
	CardContent: ({ children, ...props }: React.HTMLAttributes<HTMLDivElement>) => (
		<div {...props}>{children}</div>
	),
	CardHeader: ({ children, ...props }: React.HTMLAttributes<HTMLDivElement>) => (
		<div {...props}>{children}</div>
	),
	CardTitle: ({ children, ...props }: React.HTMLAttributes<HTMLHeadingElement>) => (
		<h2 {...props}>{children}</h2>
	),
	NativeSelect: ({ children, ...props }: React.SelectHTMLAttributes<HTMLSelectElement>) => (
		<select {...props}>{children}</select>
	),
	SelectOption: ({ children, ...props }: React.OptionHTMLAttributes<HTMLOptionElement>) => (
		<option {...props}>{children}</option>
	),
}));
vi.mock("../../../../hooks/api/useServicesQuery", () => ({
	useServicesQuery: () => ({
		data: state.servicesSuccess ? state.services : undefined,
		isSuccess: state.servicesSuccess,
		isLoading: state.servicesLoading,
		isError: state.servicesError,
		refetch: state.servicesRefetch,
	}),
}));
vi.mock("../../../../hooks/api/useProviderNativeInventory", () => ({
	useProviderNativeInventory: (options: Record<string, unknown>) => {
		state.hookCalls.push(options);
		return {
			data: state.data,
			isLoading: state.isLoading,
			isFetching: state.isFetching,
			isError: state.isError,
			refetch: state.refetch,
		};
	},
}));
vi.mock("../../../../lib/incognito", () => ({
	useIncognitoMode: () => [state.incognito, vi.fn()],
	getLinuxInstanceName: () => "Masked server",
	getLinuxIsoName: () => "masked-item.iso",
}));

import { ProviderNativeInventoryPanel } from "../provider-native-inventory-panel";

function service(id: string, label: string): ServiceInstanceSummary {
	return {
		id,
		service: id.startsWith("jellyfin") ? "jellyfin" : "plex",
		label,
		baseUrl: "http://private.invalid",
		externalUrl: null,
		enabled: true,
		isDefault: false,
		hasApiKey: true,
		hasHttpAuth: false,
		storageGroupId: null,
		hasLocalFilesystemAccess: false,
		pathPrefix: null,
		identity: {
			status: "verified",
			kind: "server",
			fingerprint: "private",
			verifiedAt: null,
			lastCheckedAt: null,
		},
		createdAt: "2026-09-14T00:00:00.000Z",
		updatedAt: "2026-09-14T00:00:00.000Z",
		tags: [],
	};
}

function available(
	overrides: Partial<Extract<ProviderNativeInventoryResponse, { status: "available" }>> = {},
) {
	return {
		status: "available" as const,
		generationId: "generation-1",
		observedAt: "2026-09-14T12:00:00.000Z",
		itemCount: 1,
		scopeCount: 1,
		lastAttemptAt: "2026-09-14T12:00:00.000Z",
		lastAttemptResult: "success" as const,
		lastAttemptReason: null,
		freshness: "current" as const,
		complete: true,
		rows: [
			{
				nativeId: "native-1",
				mediaType: "movie" as const,
				libraryIds: ["library-1"],
				parentNativeId: null,
				seasonNumber: null,
				episodeNumber: null,
				title: "Private movie title",
			},
		],
		nextNativeId: null,
		...overrides,
	};
}

it("shows recorded watch coverage separately while retaining known, last-known and unknown badges", async () => {
	state.services = [service("jellyfin-1", "Private server")];
	state.data = available({
		watchCoverage: {
			status: "available",
			observedAt: "2026-09-14T12:00:00.000Z",
			expectedScopes: 8,
			verifiedScopes: 7,
			incompleteScopes: 1,
			diagnosticStatus: "recorded",
			reasonCodes: ["changed-observations", "coverage-incomplete"],
			refreshPhase: "finalizing",
		},
		rows: [
			{
				nativeId: "one",
				mediaType: "episode",
				libraryIds: ["library-1"],
				parentNativeId: "series",
				seasonNumber: 1,
				episodeNumber: 1,
				title: "Known",
				watch: {
					state: "unwatched",
					freshness: "last-known",
					valueSemantics: "exact",
					observedAt: "2026-09-14T12:00:00.000Z",
				},
			},
			{
				nativeId: "two",
				mediaType: "episode",
				libraryIds: ["library-1"],
				parentNativeId: "series",
				seasonNumber: 1,
				episodeNumber: 2,
				title: "Unknown",
				watch: {
					state: "unknown",
					freshness: "unavailable",
					valueSemantics: "unknown",
					observedAt: null,
				},
			},
		],
	});
	render(<ProviderNativeInventoryPanel />);
	fireEvent.change(screen.getByLabelText("Inventory domain"), { target: { value: "episode" } });
	expect(await screen.findByText("Recorded watch coverage")).toBeInTheDocument();
	expect(screen.getByText(/7 of 8 scopes verified/)).toBeInTheDocument();
	expect(
		screen.getByText(/Observations changed between collection and verification/),
	).toBeInTheDocument();
	expect(screen.getByText("Unwatched")).toBeInTheDocument();
	expect(screen.getByText("Last known")).toBeInTheDocument();
	expect(screen.getByText("Watch state unknown")).toBeInTheDocument();
	expect(screen.getByText(/Absence is not proof of unwatched/)).toBeInTheDocument();
	expect(screen.getByRole("link", { name: "View watch refresh in Pulse" })).toHaveAttribute(
		"href",
		"/pulse",
	);
	expect(
		screen.queryByRole("button", { name: "Refresh watch observations" }),
	).not.toBeInTheDocument();
});

it("explains positive-only Plex unknown evidence without asserting unwatched", () => {
	state.services = [service("plex-1", "Private server")];
	state.data = available();
	render(<ProviderNativeInventoryPanel />);
	fireEvent.change(screen.getByLabelText("Inventory domain"), { target: { value: "episode" } });
	expect(
		screen.getByText(/Plex watch badges use positive watched observations only/),
	).toBeInTheDocument();
});

beforeEach(() => {
	state.incognito = false;
	state.data = available();
	state.isLoading = false;
	state.isFetching = false;
	state.isError = false;
	state.servicesSuccess = true;
	state.servicesLoading = false;
	state.servicesError = false;
	state.servicesRefetch.mockReset();
	state.refetch.mockReset();
	state.hookCalls.length = 0;
	state.services = [
		service("plex-1", "Private Plex"),
		service("plex-2", "Other private Plex"),
		service("jellyfin-1", "Private Jellyfin"),
		{ ...service("radarr-1", "Private Radarr"), service: "radarr" },
	];
	window.history.replaceState({}, "", "/library");
});

describe("ProviderNativeInventoryPanel", () => {
	describe("Plex metadata review", () => {
		it.each([undefined, {}, { tmdb: [] }, { tvdb: [42] }, { tmdb: [42, 99] }])(
			"highlights recorded Plex library mapping gaps without relying on the ARR relationship: %j",
			(externalIds) => {
				state.data = available({
					rows: [
						{
							...available().rows[0]!,
							externalIds,
							connection: { status: "matched", reason: "matched-identifiers", arrItems: [] },
						},
					],
				});
				render(<ProviderNativeInventoryPanel />, { wrapper: IncognitoProvider });
				expect(screen.getByText("Metadata review needed")).toBeInTheDocument();
				expect(screen.getByText("No unique TMDB mapping")).toBeInTheDocument();
				expect(screen.getByText("Matched ARR item")).toBeInTheDocument();
				expect(screen.getByText("Private movie title")).toBeInTheDocument();
			},
		);
		it("does not mistake a missing ARR relationship for a missing Plex metadata match", () => {
			state.data = available({
				rows: [
					{
						...available().rows[0]!,
						externalIds: { tmdb: [42] },
						connection: { status: "unmatched", reason: "no-arr-match", arrItems: [] },
					},
				],
			});
			render(<ProviderNativeInventoryPanel />, { wrapper: IncognitoProvider });
			expect(screen.queryByText("Metadata review needed")).not.toBeInTheDocument();
			expect(screen.getByText("No ARR match")).toBeInTheDocument();
		});
		it.each(["jellyfin", "emby"] as const)(
			"does not prescribe Plex matching for %s library items",
			(provider) => {
				state.services = [{ ...service(`${provider}-1`, "Private server"), service: provider }];
				render(<ProviderNativeInventoryPanel />, { wrapper: IncognitoProvider });
				expect(screen.queryByText("Metadata review needed")).not.toBeInTheDocument();
				expect(screen.queryByText("Check matching in Plex")).not.toBeInTheDocument();
			},
		);
		it("does not interpret a Plex episode's absent TMDB identifier as a library matching issue", () => {
			state.data = available({
				rows: [
					{
						...available().rows[0]!,
						mediaType: "episode",
						parentNativeId: "parent-1",
						seasonNumber: 1,
						episodeNumber: 1,
					},
				],
			});
			render(<ProviderNativeInventoryPanel />, { wrapper: IncognitoProvider });
			fireEvent.change(screen.getByLabelText("Inventory domain"), { target: { value: "episode" } });
			expect(screen.queryByText("Metadata review needed")).not.toBeInTheDocument();
		});
		it("offers manual matching guidance without claiming the item is definitely unmatched", () => {
			render(<ProviderNativeInventoryPanel />, { wrapper: IncognitoProvider });
			const disclosure = screen.getByText("Check matching in Plex");
			const guidance = screen.getByText(/does not prove this item is unmatched/);
			expect(guidance).not.toBeVisible();
			fireEvent.click(disclosure);
			expect(guidance).toBeVisible();
			expect(screen.getByText(/allow the normal cache refresh/)).toBeVisible();
			expect(screen.getByText(/does not change watch state or cleanup eligibility/)).toBeVisible();
			expect(
				screen.queryByRole("link", { name: "Check matching in Plex" }),
			).not.toBeInTheDocument();
		});
		it("keeps actionable metadata warnings in incognito without revealing item titles", () => {
			state.incognito = true;
			render(<ProviderNativeInventoryPanel />, { wrapper: IncognitoProvider });
			expect(screen.getByText("Metadata review needed")).toBeInTheDocument();
			expect(screen.getByText("Check matching in Plex")).toBeInTheDocument();
			expect(screen.getByText("masked-item.iso")).toBeInTheDocument();
			expect(screen.queryByText("Private movie title")).not.toBeInTheDocument();
		});
	});
	it("opens the linked provider and domain rather than the first available inventory", async () => {
		window.history.replaceState(
			{},
			"",
			"/library?inventoryInstanceId=plex-2&inventoryDomain=episode#media-server-inventory",
		);
		render(<ProviderNativeInventoryPanel />);
		await waitFor(() =>
			expect(state.hookCalls.at(-1)).toMatchObject({ instanceId: "plex-2", domain: "episode" }),
		);
	});
	it("opens a Plex metadata deep link with the published inventory filter selected", async () => {
		window.history.replaceState(
			{},
			"",
			"/library?inventoryInstanceId=plex-2&inventoryDomain=library&inventoryMetadataFilter=missing-tmdb#media-server-inventory",
		);
		render(<ProviderNativeInventoryPanel />);
		await waitFor(() =>
			expect(state.hookCalls.at(-1)).toMatchObject({
				instanceId: "plex-2",
				domain: "library",
				metadataFilter: "missing-tmdb",
			}),
		);
		expect((screen.getByLabelText("Inventory filter") as HTMLSelectElement).value).toBe(
			"missing-tmdb",
		);
	});
	it("waits for a refreshed service list before applying a metadata deep link", async () => {
		state.services = [service("plex-1", "Private Plex")];
		window.history.replaceState(
			{},
			"",
			"/library?inventoryInstanceId=plex-2&inventoryDomain=library&inventoryMetadataFilter=missing-tmdb#media-server-inventory",
		);
		const view = render(<ProviderNativeInventoryPanel />);
		expect(state.hookCalls.at(-1)).toMatchObject({
			instanceId: "plex-1",
			metadataFilter: null,
		});
		state.services = [service("plex-1", "Private Plex"), service("plex-2", "Other private Plex")];
		view.rerender(<ProviderNativeInventoryPanel />);
		await waitFor(() =>
			expect(state.hookCalls.at(-1)).toMatchObject({
				instanceId: "plex-2",
				metadataFilter: "missing-tmdb",
			}),
		);
	});
	it("keeps a manual provider choice when a missing deep-link target arrives later", async () => {
		state.services = [service("plex-1", "Private Plex"), service("jellyfin-1", "Private Jellyfin")];
		window.history.replaceState(
			{},
			"",
			"/library?inventoryInstanceId=plex-2&inventoryDomain=library&inventoryMetadataFilter=missing-tmdb#media-server-inventory",
		);
		const view = render(<ProviderNativeInventoryPanel />);
		fireEvent.change(screen.getByLabelText("Provider"), { target: { value: "jellyfin-1" } });
		state.services = [...state.services, service("plex-2", "Other private Plex")];
		view.rerender(<ProviderNativeInventoryPanel />);
		await waitFor(() =>
			expect(state.hookCalls.at(-1)).toMatchObject({
				instanceId: "jellyfin-1",
				metadataFilter: null,
			}),
		);
	});
	it("ignores a metadata deep link for a non-Plex inventory", async () => {
		window.history.replaceState(
			{},
			"",
			"/library?inventoryInstanceId=jellyfin-1&inventoryDomain=library&inventoryMetadataFilter=missing-tmdb#media-server-inventory",
		);
		render(<ProviderNativeInventoryPanel />);
		await waitFor(() =>
			expect(state.hookCalls.at(-1)).toMatchObject({
				instanceId: "jellyfin-1",
				domain: "library",
				metadataFilter: null,
			}),
		);
		expect(screen.queryByLabelText("Inventory filter")).not.toBeInTheDocument();
	});
	it("lets an admin narrow the Plex library to published missing-TMDb rows", async () => {
		state.data = available({
			itemCount: 2,
			filteredItemCount: 1,
			rows: [
				{
					nativeId: "unmapped",
					mediaType: "movie",
					libraryIds: ["library-1"],
					parentNativeId: null,
					seasonNumber: null,
					episodeNumber: null,
					title: "Private unmatched movie",
				},
			],
		});
		render(<ProviderNativeInventoryPanel />);
		await waitFor(() =>
			expect((screen.getByLabelText("Provider") as HTMLSelectElement).value).toBe("plex-1"),
		);
		fireEvent.change(screen.getByLabelText("Inventory filter"), {
			target: { value: "missing-tmdb" },
		});
		expect(state.hookCalls.at(-1)).toMatchObject({ metadataFilter: "missing-tmdb" });
		expect(
			screen.getByText(/1 of 2 recorded items need Plex metadata matching/i),
		).toBeInTheDocument();
		fireEvent.change(screen.getByLabelText("Inventory domain"), {
			target: { value: "episode" },
		});
		expect(state.hookCalls.at(-1)).toMatchObject({ domain: "episode", metadataFilter: null });
	});
	it("shows watched, unwatched, last-known, and unknown native episode evidence without ARR matches", () => {
		const row = {
			nativeId: "episode-1",
			mediaType: "episode" as const,
			libraryIds: ["library-1"],
			parentNativeId: "series-1",
			seasonNumber: 1,
			episodeNumber: 1,
			title: "Private episode title",
			connection: { status: "unmatched" as const, reason: "no-arr-match" as const, arrItems: [] },
		};
		state.data = available({
			itemCount: 4,
			rows: [
				{
					...row,
					watch: {
						state: "watched",
						freshness: "current",
						valueSemantics: "exact",
						observedAt: "2026-09-14T12:00:00.000Z",
					},
				},
				{
					...row,
					nativeId: "episode-2",
					watch: {
						state: "unwatched",
						freshness: "current",
						valueSemantics: "exact",
						observedAt: "2026-09-14T12:00:00.000Z",
					},
				},
				{
					...row,
					nativeId: "episode-3",
					watch: {
						state: "watched",
						freshness: "last-known",
						valueSemantics: "lower-bound",
						observedAt: "2026-09-14T11:00:00.000Z",
					},
				},
				{
					...row,
					nativeId: "episode-4",
					watch: {
						state: "unknown",
						freshness: "unavailable",
						valueSemantics: "unknown",
						observedAt: null,
					},
				},
			],
		});
		state.incognito = true;
		render(<ProviderNativeInventoryPanel />);
		expect(screen.getAllByText("Watched")).toHaveLength(2);
		expect(screen.getByText("Unwatched")).toBeInTheDocument();
		expect(screen.getByText("Watch state unknown")).toBeInTheDocument();
		expect(screen.getByText("Last known")).toBeInTheDocument();
		expect(screen.getAllByText("No ARR match")).toHaveLength(4);
		expect(screen.queryByText("Private episode title")).not.toBeInTheDocument();
		expect(screen.getAllByText("masked-item.iso")).toHaveLength(4);
	});

	it("renders a complete recorded page and supported scope guidance", () => {
		render(<ProviderNativeInventoryPanel />);

		expect(screen.getByText("Media server inventory")).toBeInTheDocument();
		expect(screen.getByText("Private movie title")).toBeInTheDocument();
		expect(screen.getByText("1 recorded item")).toBeInTheDocument();
		expect(screen.getByText("Complete at last scan")).toBeInTheDocument();
		expect(screen.getByText(/items without a Radarr or Sonarr match/i)).toBeInTheDocument();
	});

	it("identifies the matching ARR connection and masks its label in incognito", () => {
		const data = available();
		state.data = {
			...data,
			rows: data.rows.map((row) => ({
				...row,
				connection: {
					status: "matched",
					reason: "matched-identifiers",
					arrItems: [
						{
							instanceId: "radarr-1",
							arrItemId: 10,
							itemType: "movie",
							title: "Private ARR title",
						},
					],
				},
			})),
		};
		const view = render(<ProviderNativeInventoryPanel />);
		expect(screen.getByText(/Private ARR title.*Private Radarr/)).toBeInTheDocument();
		state.incognito = true;
		view.rerender(<ProviderNativeInventoryPanel />);
		expect(screen.queryByText(/Private Radarr|Private ARR title/)).not.toBeInTheDocument();
		expect(screen.getByText(/ARR: masked-item.iso.*Masked server/)).toBeInTheDocument();
	});
	it("keeps every connection status visible and explains episode parent matches", () => {
		state.data = available({
			itemCount: 4,
			rows: [
				{
					nativeId: "movie-1",
					mediaType: "movie",
					libraryIds: ["library-1"],
					parentNativeId: null,
					seasonNumber: null,
					episodeNumber: null,
					title: "Matched movie",
					connection: {
						status: "matched",
						reason: "matched-identifiers",
						arrItems: [
							{ instanceId: "plex-1", arrItemId: 42, itemType: "movie", title: "ARR movie" },
						],
					},
				},
				{
					nativeId: "movie-2",
					mediaType: "movie",
					libraryIds: ["library-1"],
					parentNativeId: null,
					seasonNumber: null,
					episodeNumber: null,
					title: "Unmatched movie",
					connection: { status: "unmatched", reason: "no-arr-match", arrItems: [] },
				},
				{
					nativeId: "movie-3",
					mediaType: "movie",
					libraryIds: ["library-1"],
					parentNativeId: null,
					seasonNumber: null,
					episodeNumber: null,
					title: "Ambiguous movie",
					connection: { status: "ambiguous", reason: "multiple-arr-items", arrItems: [] },
				},
				{
					nativeId: "episode-1",
					mediaType: "episode",
					libraryIds: ["library-1"],
					parentNativeId: "series-1",
					seasonNumber: 1,
					episodeNumber: 2,
					title: "Episode title",
					connection: {
						status: "unknown",
						reason: "parent-unavailable",
						arrItems: [
							{ instanceId: "plex-1", arrItemId: 43, itemType: "series", title: "Parent series" },
						],
					},
				},
			],
		});
		render(<ProviderNativeInventoryPanel />);

		expect(screen.getByText("Matched ARR item")).toBeInTheDocument();
		expect(screen.getByText("No ARR match")).toBeInTheDocument();
		expect(screen.getByText("Ambiguous ARR match")).toBeInTheDocument();
		expect(screen.getByText("ARR match unknown")).toBeInTheDocument();
		expect(screen.getByText("ARR parent series: Parent series (Private Plex)")).toBeInTheDocument();
		expect(
			screen.getByText(/parent series connection could not be confirmed/i),
		).toBeInTheDocument();
	});

	it("keeps unknown and unavailable states from claiming an empty inventory", () => {
		state.data = undefined;
		state.isLoading = true;
		const { rerender } = render(<ProviderNativeInventoryPanel />);
		expect(screen.getByText(/loading recorded inventory/i)).toBeInTheDocument();
		expect(screen.queryByText(/0 recorded items?/i)).not.toBeInTheDocument();

		state.isLoading = false;
		state.data = { status: "unavailable", reason: "provider-unavailable" };
		rerender(<ProviderNativeInventoryPanel />);
		expect(screen.getByText(/provider connection is unavailable/i)).toBeInTheDocument();
		expect(screen.queryByText(/0 recorded items?/i)).not.toBeInTheDocument();
	});

	it("shows connection loading and retry controls without implying inventory state", () => {
		state.servicesSuccess = false;
		state.servicesLoading = true;
		state.data = undefined;
		const { rerender } = render(<ProviderNativeInventoryPanel />);
		expect(screen.getByText(/loading media server connections/i)).toBeInTheDocument();
		expect(screen.queryByText(/recorded item/i)).not.toBeInTheDocument();

		state.servicesLoading = false;
		state.servicesError = true;
		rerender(<ProviderNativeInventoryPanel />);
		expect(screen.getByText(/could not load media server connections/i)).toBeInTheDocument();
		fireEvent.click(screen.getByText("Reload services"));
		expect(state.servicesRefetch).toHaveBeenCalledTimes(1);
	});

	it("labels stale or failed snapshots as last known and unconfirmed", () => {
		state.data = available({
			freshness: "last-known",
			complete: false,
			lastAttemptResult: "failed",
		});
		render(<ProviderNativeInventoryPanel />);

		expect(screen.getByText("Last known inventory")).toBeInTheDocument();
		expect(screen.getByText(/current scan is not confirmed/i)).toBeInTheDocument();
	});

	it("shows bounded scan progress separately from retained last-known rows", () => {
		state.data = available({
			freshness: "last-known",
			complete: false,
			attempt: {
				state: "running",
				passOrdinal: 2,
				pagesCompleted: 3,
				itemsStaged: 300,
				failureCount: 0,
				reasonCode: null,
			},
		});
		render(<ProviderNativeInventoryPanel />);
		expect(screen.getByText("Last known inventory")).toBeInTheDocument();
		expect(screen.getByText(/inventory scan in progress/i)).toBeInTheDocument();
		expect(screen.getByText(/pass 2.*3 pages.*300 items staged/i)).toBeInTheDocument();
	});

	it("shows pending scan without publishing a zero-item catalog", () => {
		state.data = {
			status: "unavailable",
			reason: "no-publication",
			attempt: {
				state: "pending",
				passOrdinal: 1,
				pagesCompleted: 0,
				itemsStaged: 0,
				failureCount: 0,
				reasonCode: null,
			},
		};
		render(<ProviderNativeInventoryPanel />);
		expect(screen.getByText(/inventory scan is scheduled/i)).toBeInTheDocument();
		expect(screen.queryByText(/0 recorded items?/i)).not.toBeInTheDocument();
	});

	it("does not call a cached snapshot complete after a transport error", () => {
		state.isError = true;
		render(<ProviderNativeInventoryPanel />);

		expect(screen.getByText("Last known inventory")).toBeInTheDocument();
		expect(screen.getByText(/current scan is not confirmed/i)).toBeInTheDocument();
	});

	it("labels completed Jellyfin episode observations as partial rather than exact inventory", () => {
		state.data = available({
			evidence: "positive-only",
			complete: false,
			freshness: "last-known",
			lastAttemptResult: "failed",
			lastAttemptReason: "coverage-incomplete",
		});
		render(<ProviderNativeInventoryPanel />);
		expect(screen.getByText("Observed items (partial coverage)")).toBeInTheDocument();
		expect(screen.getByText(/missing items are not confirmed absent/i)).toBeInTheDocument();
		expect(screen.queryByText("Complete at last scan")).not.toBeInTheDocument();
	});

	it("clears rows on scope changes and pins the next page to the generation", async () => {
		state.data = available({
			nextNativeId: "native-2",
		});
		const { rerender } = render(<ProviderNativeInventoryPanel />);
		fireEvent.change(screen.getByLabelText("Inventory domain"), { target: { value: "episode" } });
		state.data = available({
			rows: [
				{
					nativeId: "episode-1",
					mediaType: "episode",
					libraryIds: ["library-1"],
					parentNativeId: "show-1",
					seasonNumber: 1,
					episodeNumber: 0,
					title: "Episode title",
				},
			],
		});
		rerender(<ProviderNativeInventoryPanel />);
		await waitFor(() => expect(screen.queryByText("Private movie title")).not.toBeInTheDocument());
		expect(screen.getByText("Episode title")).toBeInTheDocument();

		state.data = available({
			rows: [
				{
					nativeId: "native-2",
					mediaType: "movie",
					libraryIds: ["library-1"],
					parentNativeId: null,
					seasonNumber: null,
					episodeNumber: null,
					title: "Second movie",
				},
			],
			nextNativeId: "native-2",
		});
		fireEvent.change(screen.getByLabelText("Inventory domain"), { target: { value: "library" } });
		await waitFor(() => expect(screen.getByText("Next page")).toBeInTheDocument());
		fireEvent.click(screen.getByText("Next page"));
		await waitFor(() => {
			const call = state.hookCalls.at(-1);
			expect(call?.afterNativeId).toBe("native-2");
			expect(call?.expectedGenerationId).toBe("generation-1");
		});
	});

	it("explains snapshot changes and masks provider names and titles in incognito", () => {
		state.incognito = true;
		state.data = { status: "unavailable", reason: "snapshot-changed" };
		render(<ProviderNativeInventoryPanel />);

		expect(
			screen.getByText(
				"The inventory changed while you were browsing. Reload to see the latest scan.",
			),
		).toBeInTheDocument();
		expect(screen.queryByText(/snapshot-changed/i)).not.toBeInTheDocument();
		expect(screen.getAllByText("Masked server (Plex)")).toHaveLength(2);
		expect(screen.queryByText("Private movie title")).not.toBeInTheDocument();
		expect(screen.queryByRole("button", { name: /delete|watch|monitor/i })).not.toBeInTheDocument();
	});
});
