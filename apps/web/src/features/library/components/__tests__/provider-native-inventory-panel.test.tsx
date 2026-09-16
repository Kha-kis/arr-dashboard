import type { ProviderNativeInventoryResponse, ServiceInstanceSummary } from "@arr/shared";
import { fireEvent, render, screen, waitFor } from "@testing-library/react";
import { beforeEach, describe, expect, it, vi } from "vitest";

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
	hookCalls: [] as Array<Record<string, unknown>>,
}));

vi.mock("../../../../components/ui", () => ({
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
		data: state.servicesSuccess
			? [
					service("plex-1", "Private Plex"),
					service("jellyfin-1", "Private Jellyfin"),
					{ ...service("radarr-1", "Private Radarr"), service: "radarr" },
				]
			: undefined,
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
});

describe("ProviderNativeInventoryPanel", () => {
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

	it("does not call a cached snapshot complete after a transport error", () => {
		state.isError = true;
		render(<ProviderNativeInventoryPanel />);

		expect(screen.getByText("Last known inventory")).toBeInTheDocument();
		expect(screen.getByText(/current scan is not confirmed/i)).toBeInTheDocument();
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

	it("offers reload after a snapshot changes and masks provider names and titles in incognito", () => {
		state.incognito = true;
		state.data = { status: "unavailable", reason: "snapshot-changed" };
		render(<ProviderNativeInventoryPanel />);

		fireEvent.click(screen.getByText("Reload"));
		expect(state.hookCalls.at(-1)?.refreshKey).toBe(1);
		expect(
			screen.getByText(
				"The inventory changed while you were browsing. Reload to see the latest scan.",
			),
		).toBeInTheDocument();
		expect(screen.queryByText(/snapshot-changed/i)).not.toBeInTheDocument();
		expect(screen.getByText("Masked server (Plex)")).toBeInTheDocument();
		expect(screen.queryByText("Private movie title")).not.toBeInTheDocument();
		expect(screen.queryByRole("button", { name: /delete|watch|monitor/i })).not.toBeInTheDocument();
	});
});
