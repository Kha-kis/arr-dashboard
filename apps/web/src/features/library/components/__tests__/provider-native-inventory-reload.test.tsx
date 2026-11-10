import type { ProviderNativeInventoryResponse, ServiceInstanceSummary } from "@arr/shared";
import { QueryClient, QueryClientProvider } from "@tanstack/react-query";
import { act, fireEvent, render, screen, waitFor } from "@testing-library/react";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { IncognitoProvider } from "../../../../contexts/IncognitoContext";
import { ColorThemeProvider } from "../../../../providers/color-theme-provider";

const apiRequest = vi.hoisted(() => vi.fn());
vi.mock("../../../../lib/api-client/base", () => ({ apiRequest }));
vi.mock("../../../../hooks/api/useServicesQuery", () => ({
	useServicesQuery: () => ({
		data: services,
		isSuccess: true,
		isLoading: false,
		isError: false,
		refetch: () => Promise.resolve(),
	}),
}));

import { ProviderNativeInventoryPanel } from "../provider-native-inventory-panel";

const services: ServiceInstanceSummary[] = ["plex-one", "plex-two"].map((id) => ({
	id,
	service: "plex",
	label: id,
	baseUrl: "https://synthetic.invalid",
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
		fingerprint: "synthetic",
		verifiedAt: null,
		lastCheckedAt: null,
	},
	createdAt: "2026-11-05T00:00:00.000Z",
	updatedAt: "2026-11-05T00:00:00.000Z",
	tags: [],
}));

function inventory(
	overrides: Partial<Extract<ProviderNativeInventoryResponse, { status: "available" }>> = {},
): ProviderNativeInventoryResponse {
	return {
		status: "available",
		generationId: "generation-one",
		observedAt: "2026-11-05T12:00:00.000Z",
		itemCount: 1,
		scopeCount: 1,
		lastAttemptAt: "2026-11-05T12:00:00.000Z",
		lastAttemptResult: "success",
		lastAttemptReason: null,
		freshness: "current",
		complete: true,
		rows: [
			{
				nativeId: "item-one",
				mediaType: "movie",
				libraryIds: ["library-one"],
				parentNativeId: null,
				seasonNumber: null,
				episodeNumber: null,
				title: "Synthetic first item",
				externalIds: {},
			},
		],
		nextNativeId: null,
		...overrides,
	};
}

function renderInventory() {
	const client = new QueryClient({ defaultOptions: { queries: { retry: false, gcTime: 0 } } });
	return render(
		<QueryClientProvider client={client}>
			<ColorThemeProvider>
				<IncognitoProvider>
					<ProviderNativeInventoryPanel />
				</IncognitoProvider>
			</ColorThemeProvider>
		</QueryClientProvider>,
	);
}

beforeEach(() => {
	localStorage.setItem("arr-dashboard-incognito-mode", "false");
	window.history.replaceState({}, "", "/library");
});

afterEach(() => {
	localStorage.clear();
	apiRequest.mockReset();
});

describe("native inventory Reload with the real query hook", () => {
	it("retains the first-page metadata warning through pending and failed Reload until a verified replacement", async () => {
		const retry = Promise.withResolvers<ProviderNativeInventoryResponse>();
		const fixed = inventory();
		if (fixed.status !== "available") throw new Error("Invalid synthetic fixture");
		apiRequest
			.mockResolvedValueOnce(inventory())
			.mockReturnValueOnce(retry.promise)
			.mockResolvedValueOnce({
				...fixed,
				generationId: "generation-two",
				rows: [{ ...fixed.rows[0]!, externalIds: { tmdb: [42] } }],
			});
		renderInventory();
		expect(await screen.findByText("Metadata review needed")).toBeInTheDocument();
		fireEvent.click(screen.getByRole("button", { name: "Reload media server inventory" }));
		await waitFor(() => expect(apiRequest).toHaveBeenCalledTimes(2));
		expect(screen.getByText("Synthetic first item")).toBeInTheDocument();
		expect(screen.getByText("Metadata review needed")).toBeInTheDocument();
		await act(async () => retry.reject(new Error("Synthetic read unavailable")));
		expect(await screen.findByRole("alert")).toBeInTheDocument();
		expect(screen.getByText("Metadata review needed")).toBeInTheDocument();
		expect(screen.getByText("Last known inventory")).toBeInTheDocument();
		fireEvent.click(screen.getByRole("button", { name: "Reload media server inventory" }));
		await waitFor(() =>
			expect(screen.queryByText("Metadata review needed")).not.toBeInTheDocument(),
		);
		expect(screen.getByText("Synthetic first item")).toBeInTheDocument();
		expect(screen.queryByRole("alert")).not.toBeInTheDocument();
	});

	it("does not retain another provider's recorded row or warning while its replacement loads", async () => {
		const replacement = Promise.withResolvers<ProviderNativeInventoryResponse>();
		apiRequest.mockResolvedValueOnce(inventory()).mockReturnValueOnce(replacement.promise);
		renderInventory();
		expect(await screen.findByText("Metadata review needed")).toBeInTheDocument();
		fireEvent.change(screen.getByLabelText("Provider"), { target: { value: "plex-two" } });
		await waitFor(() => expect(apiRequest).toHaveBeenCalledTimes(2));
		expect(apiRequest).toHaveBeenLastCalledWith(
			"/api/library/provider-inventory?instanceId=plex-two&domain=library&limit=100",
			{ signal: expect.any(AbortSignal) },
		);
		expect(screen.queryByText("Synthetic first item")).not.toBeInTheDocument();
		expect(screen.queryByText("Metadata review needed")).not.toBeInTheDocument();
		await act(async () => replacement.resolve({ status: "unavailable", reason: "no-publication" }));
		expect(
			await screen.findByText("No provider inventory scan has been published yet."),
		).toBeVisible();
	});

	it("still restarts a pinned continuation at the unpinned first page on Reload", async () => {
		apiRequest
			.mockResolvedValueOnce(inventory({ itemCount: 2, nextNativeId: "item-one" }))
			.mockResolvedValueOnce(
				inventory({
					itemCount: 2,
					rows: [
						{
							nativeId: "item-two",
							mediaType: "movie",
							libraryIds: ["library-one"],
							parentNativeId: null,
							seasonNumber: null,
							episodeNumber: null,
							title: "Synthetic second item",
							externalIds: { tmdb: [43] },
						},
					],
				}),
			)
			.mockResolvedValueOnce(inventory({ generationId: "generation-two" }));
		renderInventory();
		fireEvent.click(await screen.findByRole("button", { name: "Next page" }));
		await waitFor(() => expect(apiRequest).toHaveBeenCalledTimes(2));
		expect(apiRequest).toHaveBeenLastCalledWith(
			"/api/library/provider-inventory?instanceId=plex-one&domain=library&limit=100&afterNativeId=item-one&expectedGenerationId=generation-one",
			{ signal: expect.any(AbortSignal) },
		);
		expect(await screen.findByText("Synthetic second item")).toBeInTheDocument();
		expect(screen.queryByRole("button", { name: "Next page" })).not.toBeInTheDocument();
		fireEvent.click(screen.getByRole("button", { name: "Reload media server inventory" }));
		await waitFor(() => expect(apiRequest).toHaveBeenCalledTimes(3));
		expect(apiRequest).toHaveBeenLastCalledWith(
			"/api/library/provider-inventory?instanceId=plex-one&domain=library&limit=100",
			{ signal: expect.any(AbortSignal) },
		);
	});

	it("recovers an unavailable changed snapshot by reloading the unpinned first page", async () => {
		apiRequest
			.mockResolvedValueOnce({ status: "unavailable", reason: "snapshot-changed" })
			.mockResolvedValueOnce(inventory());
		renderInventory();
		expect(await screen.findByText(/inventory changed while you were browsing/)).toBeVisible();
		fireEvent.click(screen.getByRole("button", { name: "Reload media server inventory" }));
		expect(await screen.findByText("Synthetic first item")).toBeInTheDocument();
		expect(screen.queryByText(/inventory changed while you were browsing/)).not.toBeInTheDocument();
		expect(apiRequest).toHaveBeenCalledTimes(2);
		expect(apiRequest).toHaveBeenLastCalledWith(
			"/api/library/provider-inventory?instanceId=plex-one&domain=library&limit=100",
			{ signal: expect.any(AbortSignal) },
		);
	});
});
