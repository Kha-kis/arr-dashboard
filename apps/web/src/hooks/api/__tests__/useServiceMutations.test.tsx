import type { ServiceInstanceSummary } from "@arr/shared";
import { QueryClient, QueryClientProvider } from "@tanstack/react-query";
import { renderHook, waitFor } from "@testing-library/react";
import type { ReactNode } from "react";
import { beforeEach, describe, expect, it, vi } from "vitest";
import {
	libraryCleanupKeys,
	serviceKeys,
	systemKeys,
	tautulliKeys,
	tracearrKeys,
} from "../../../lib/query-keys";

vi.mock("../../../lib/api-client/services");

import * as serviceApi from "../../../lib/api-client/services";
import {
	useCreateServiceMutation,
	useDeleteServiceMutation,
	useUpdateServiceMutation,
} from "../useServiceMutations";

function createWrapper(client: QueryClient) {
	return ({ children }: { children: ReactNode }) => (
		<QueryClientProvider client={client}>{children}</QueryClientProvider>
	);
}

const tracearrService = {
	id: "tracearr-1",
	service: "tracearr",
	label: "Tracearr",
	baseUrl: "https://tracearr.example.test",
	enabled: true,
	isDefault: false,
} as ServiceInstanceSummary;

const analyticsProviderSelection = {
	selected: "tracearr",
	source: "explicit",
	families: {
		tracearr: { configuredCount: 1, enabledCount: 1 },
		tautulli: { configuredCount: 0, enabledCount: 0 },
	},
	status: "configured",
};

describe("service mutations", () => {
	beforeEach(() => {
		vi.clearAllMocks();
	});

	it("invalidates both analytics family caches after adding a provider", async () => {
		const client = new QueryClient({
			defaultOptions: { mutations: { retry: false }, queries: { retry: false } },
		});
		const invalidateQueries = vi.spyOn(client, "invalidateQueries");
		client.setQueryData(systemKeys.analyticsProvider, analyticsProviderSelection);
		client.setQueryData(tracearrKeys.stats(), { totalPlays: 1 });
		client.setQueryData(tautulliKeys.stats(30), { totalPlays: 1 });
		vi.mocked(serviceApi.createService).mockResolvedValue(tracearrService);

		const { result } = renderHook(() => useCreateServiceMutation(), {
			wrapper: createWrapper(client),
		});
		result.current.mutate({
			label: "Tracearr",
			baseUrl: "https://tracearr.example.test",
			apiKey: "test-key",
			service: "tracearr",
		});

		await waitFor(() => expect(result.current.isSuccess).toBe(true));
		expect(client.getQueryState(systemKeys.analyticsProvider)?.isInvalidated).toBe(true);
		expect(invalidateQueries).toHaveBeenCalledWith({ queryKey: serviceKeys.all });
		expect(client.getQueryState(tracearrKeys.stats())?.isInvalidated).toBe(true);
		expect(client.getQueryState(tautulliKeys.stats(30))?.isInvalidated).toBe(true);
		expect(invalidateQueries).toHaveBeenCalledWith({
			queryKey: libraryCleanupKeys.fieldOptions,
		});
		expect(invalidateQueries).toHaveBeenCalledWith({
			queryKey: systemKeys.tautulliProviderNotices,
		});
		client.clear();
	});

	it("invalidates both analytics family caches after removing a provider", async () => {
		const client = new QueryClient({
			defaultOptions: { mutations: { retry: false }, queries: { retry: false } },
		});
		const invalidateQueries = vi.spyOn(client, "invalidateQueries");
		client.setQueryData(serviceKeys.all, [tracearrService]);
		client.setQueryData(systemKeys.analyticsProvider, analyticsProviderSelection);
		client.setQueryData(tracearrKeys.stats(), { totalPlays: 1 });
		client.setQueryData(tautulliKeys.stats(30), { totalPlays: 1 });
		vi.mocked(serviceApi.removeService).mockResolvedValue(undefined);

		const { result } = renderHook(() => useDeleteServiceMutation(), {
			wrapper: createWrapper(client),
		});
		result.current.mutate(tracearrService.id);

		await waitFor(() => expect(result.current.isSuccess).toBe(true));
		expect(client.getQueryData(serviceKeys.all)).toEqual([]);
		expect(client.getQueryState(systemKeys.analyticsProvider)?.isInvalidated).toBe(true);
		expect(client.getQueryState(tracearrKeys.stats())?.isInvalidated).toBe(true);
		expect(client.getQueryState(tautulliKeys.stats(30))?.isInvalidated).toBe(true);
		expect(invalidateQueries).toHaveBeenCalledWith({
			queryKey: libraryCleanupKeys.fieldOptions,
		});
		expect(invalidateQueries).toHaveBeenCalledWith({
			queryKey: systemKeys.tautulliProviderNotices,
		});
		client.clear();
	});

	it("passes explicit analytics-unavailability confirmation to a service removal", async () => {
		const client = new QueryClient({
			defaultOptions: { mutations: { retry: false }, queries: { retry: false } },
		});
		vi.mocked(serviceApi.removeService).mockResolvedValue(undefined);

		const { result } = renderHook(() => useDeleteServiceMutation(), {
			wrapper: createWrapper(client),
		});
		result.current.mutate({
			id: tracearrService.id,
			confirmAnalyticsUnavailableFor: "tracearr",
		});

		await waitFor(() => expect(result.current.isSuccess).toBe(true));
		expect(serviceApi.removeService).toHaveBeenCalledWith(tracearrService.id, "tracearr");

		client.clear();
	});

	it("invalidates both analytics family caches after updating a provider", async () => {
		const client = new QueryClient({
			defaultOptions: { mutations: { retry: false }, queries: { retry: false } },
		});
		const invalidateQueries = vi.spyOn(client, "invalidateQueries");
		client.setQueryData(serviceKeys.all, [tracearrService]);
		client.setQueryData(systemKeys.analyticsProvider, analyticsProviderSelection);
		client.setQueryData(tracearrKeys.stats(), { totalPlays: 1 });
		client.setQueryData(tautulliKeys.stats(30), { totalPlays: 1 });
		vi.mocked(serviceApi.updateService).mockResolvedValue({ ...tracearrService, enabled: false });

		const { result } = renderHook(() => useUpdateServiceMutation(), {
			wrapper: createWrapper(client),
		});
		result.current.mutate({ id: tracearrService.id, payload: { enabled: false } });

		await waitFor(() => expect(result.current.isSuccess).toBe(true));
		expect(client.getQueryData(serviceKeys.all)).toEqual([{ ...tracearrService, enabled: false }]);
		expect(client.getQueryState(systemKeys.analyticsProvider)?.isInvalidated).toBe(true);
		expect(client.getQueryState(tracearrKeys.stats())?.isInvalidated).toBe(true);
		expect(client.getQueryState(tautulliKeys.stats(30))?.isInvalidated).toBe(true);
		expect(invalidateQueries).toHaveBeenCalledWith({
			queryKey: libraryCleanupKeys.fieldOptions,
		});
		expect(invalidateQueries).toHaveBeenCalledWith({
			queryKey: systemKeys.tautulliProviderNotices,
		});
		client.clear();
	});
});
