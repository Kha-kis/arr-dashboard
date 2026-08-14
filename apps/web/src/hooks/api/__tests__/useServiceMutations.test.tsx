import type { ServiceInstanceSummary } from "@arr/shared";
import { QueryClient, QueryClientProvider } from "@tanstack/react-query";
import { renderHook, waitFor } from "@testing-library/react";
import type { ReactNode } from "react";
import { beforeEach, describe, expect, it, vi } from "vitest";
import { libraryCleanupKeys, serviceKeys, systemKeys } from "../../../lib/query-keys";

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

describe("service mutations", () => {
	beforeEach(() => {
		vi.clearAllMocks();
	});

	it("invalidates provider notices after adding a provider", async () => {
		const client = new QueryClient({
			defaultOptions: { mutations: { retry: false }, queries: { retry: false } },
		});
		const invalidateQueries = vi.spyOn(client, "invalidateQueries");
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
		expect(invalidateQueries).toHaveBeenCalledWith({ queryKey: serviceKeys.all });
		expect(invalidateQueries).toHaveBeenCalledWith({
			queryKey: libraryCleanupKeys.fieldOptions,
		});
		expect(invalidateQueries).toHaveBeenCalledWith({
			queryKey: systemKeys.tautulliProviderNotices,
		});
		client.clear();
	});

	it("invalidates provider notices after removing a provider", async () => {
		const client = new QueryClient({
			defaultOptions: { mutations: { retry: false }, queries: { retry: false } },
		});
		const invalidateQueries = vi.spyOn(client, "invalidateQueries");
		client.setQueryData(serviceKeys.all, [tracearrService]);
		vi.mocked(serviceApi.removeService).mockResolvedValue(undefined);

		const { result } = renderHook(() => useDeleteServiceMutation(), {
			wrapper: createWrapper(client),
		});
		result.current.mutate(tracearrService.id);

		await waitFor(() => expect(result.current.isSuccess).toBe(true));
		expect(client.getQueryData(serviceKeys.all)).toEqual([]);
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
		result.current.mutate({ id: tracearrService.id, confirmAnalyticsUnavailable: true });

		await waitFor(() => expect(result.current.isSuccess).toBe(true));
		expect(serviceApi.removeService).toHaveBeenCalledWith(tracearrService.id, true);

		client.clear();
	});

	it("invalidates provider notices after updating a provider", async () => {
		const client = new QueryClient({
			defaultOptions: { mutations: { retry: false }, queries: { retry: false } },
		});
		const invalidateQueries = vi.spyOn(client, "invalidateQueries");
		client.setQueryData(serviceKeys.all, [tracearrService]);
		vi.mocked(serviceApi.updateService).mockResolvedValue({ ...tracearrService, enabled: false });

		const { result } = renderHook(() => useUpdateServiceMutation(), {
			wrapper: createWrapper(client),
		});
		result.current.mutate({ id: tracearrService.id, payload: { enabled: false } });

		await waitFor(() => expect(result.current.isSuccess).toBe(true));
		expect(client.getQueryData(serviceKeys.all)).toEqual([{ ...tracearrService, enabled: false }]);
		expect(invalidateQueries).toHaveBeenCalledWith({
			queryKey: libraryCleanupKeys.fieldOptions,
		});
		expect(invalidateQueries).toHaveBeenCalledWith({
			queryKey: systemKeys.tautulliProviderNotices,
		});
		client.clear();
	});
});
