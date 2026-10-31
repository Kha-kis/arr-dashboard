import type { ServiceInstanceSummary } from "@arr/shared";
import { QueryClient, QueryClientProvider, useQuery } from "@tanstack/react-query";
import { renderHook, waitFor } from "@testing-library/react";
import type { ReactNode } from "react";
import { describe, expect, it, vi } from "vitest";
import {
	dashboardKeys,
	jellyfinKeys,
	libraryCleanupKeys,
	plexKeys,
	quiKeys,
	serviceKeys,
	tautulliKeys,
	trashCacheKeys,
} from "../../../lib/query-keys";

vi.mock("../../../lib/api-client/services");

import * as servicesApi from "../../../lib/api-client/services";
import {
	useCreateServiceMutation,
	useDeleteServiceMutation,
	useReplaceServiceIdentityMutation,
	useUpdateServiceMutation,
	useVerifyServiceIdentityMutation,
} from "../useServiceMutations";

const unverifiedService: ServiceInstanceSummary = {
	id: "plex-1",
	service: "plex",
	label: "Living Room",
	baseUrl: "http://plex.test",
	externalUrl: null,
	enabled: true,
	isDefault: false,
	hasApiKey: true,
	hasHttpAuth: false,
	storageGroupId: null,
	hasLocalFilesystemAccess: false,
	pathPrefix: null,
	identity: {
		status: "unverified",
		kind: null,
		fingerprint: null,
		verifiedAt: null,
		lastCheckedAt: null,
	},
	createdAt: "2026-08-14T00:00:00.000Z",
	updatedAt: "2026-08-14T00:00:00.000Z",
	tags: [],
};

function wrapper(client: QueryClient) {
	return ({ children }: { children: ReactNode }) => (
		<QueryClientProvider client={client}>{children}</QueryClientProvider>
	);
}

describe("service identity mutations", () => {
	it("invalidates qUI Library summaries after service creation and deletion", async () => {
		const client = new QueryClient({ defaultOptions: { mutations: { retry: false } } });
		const invalidateQueries = vi.spyOn(client, "invalidateQueries");
		vi.mocked(servicesApi.createService).mockResolvedValue(unverifiedService);
		vi.mocked(servicesApi.removeService).mockResolvedValue(undefined);
		const create = renderHook(() => useCreateServiceMutation(), { wrapper: wrapper(client) });
		const remove = renderHook(() => useDeleteServiceMutation(), { wrapper: wrapper(client) });
		create.result.current.mutate({
			service: "plex",
			label: "test",
			baseUrl: "http://test.invalid",
			apiKey: "synthetic-test-key",
		});
		await waitFor(() => expect(create.result.current.isSuccess).toBe(true));
		expect(invalidateQueries).toHaveBeenCalledWith({ queryKey: quiKeys.all });
		expect(invalidateQueries).toHaveBeenCalledWith({ queryKey: dashboardKeys.statistics });
		invalidateQueries.mockClear();
		remove.result.current.mutate("plex-1");
		await waitFor(() => expect(remove.result.current.isSuccess).toBe(true));
		expect(invalidateQueries).toHaveBeenCalledWith({ queryKey: quiKeys.all });
		expect(invalidateQueries).toHaveBeenCalledWith({ queryKey: dashboardKeys.statistics });
		client.clear();
	});

	it("invalidates provider and cleanup evidence after an ordinary service update", async () => {
		const client = new QueryClient({ defaultOptions: { mutations: { retry: false } } });
		client.setQueryData(serviceKeys.all, [unverifiedService]);
		const invalidateQueries = vi.spyOn(client, "invalidateQueries");
		const updated = { ...unverifiedService, enabled: false };
		vi.mocked(servicesApi.updateService).mockResolvedValue(updated);
		const mutation = renderHook(() => useUpdateServiceMutation(), {
			wrapper: wrapper(client),
		});

		mutation.result.current.mutate({ id: "plex-1", payload: { enabled: false } });

		await waitFor(() =>
			expect(client.getQueryData<ServiceInstanceSummary[]>(serviceKeys.all)?.[0]?.enabled).toBe(
				false,
			),
		);
		expect(invalidateQueries).toHaveBeenCalledWith({ queryKey: trashCacheKeys.cacheHealth });
		expect(invalidateQueries).toHaveBeenCalledWith({ queryKey: plexKeys.cacheHealth() });
		expect(invalidateQueries).toHaveBeenCalledWith({ queryKey: jellyfinKeys.cacheHealth() });
		expect(invalidateQueries).toHaveBeenCalledWith({ queryKey: plexKeys.all });
		expect(invalidateQueries).toHaveBeenCalledWith({ queryKey: jellyfinKeys.all });
		expect(invalidateQueries).toHaveBeenCalledWith({ queryKey: tautulliKeys.all });
		expect(invalidateQueries).toHaveBeenCalledWith({ queryKey: quiKeys.all });
		expect(invalidateQueries).toHaveBeenCalledWith({ queryKey: libraryCleanupKeys.status });
		expect(invalidateQueries).toHaveBeenCalledWith({ queryKey: libraryCleanupKeys.approvals });
		expect(invalidateQueries).toHaveBeenCalledWith({ queryKey: dashboardKeys.statistics });
		client.clear();
	});

	it("updates a mounted service consumer after verification and invalidates dependent health", async () => {
		const client = new QueryClient({ defaultOptions: { mutations: { retry: false } } });
		client.setQueryData(serviceKeys.all, [unverifiedService]);
		const invalidateQueries = vi.spyOn(client, "invalidateQueries");
		const verified = {
			...unverifiedService,
			identity: {
				status: "verified" as const,
				kind: "plex-machine-identifier",
				fingerprint: "7a9c6d3e1f20",
				verifiedAt: "2026-08-14T01:00:00.000Z",
				lastCheckedAt: "2026-08-14T01:00:00.000Z",
			},
		};
		vi.mocked(servicesApi.verifyServiceIdentity).mockResolvedValue(verified);
		const consumer = renderHook(
			() =>
				useQuery({
					queryKey: serviceKeys.all,
					queryFn: async (): Promise<ServiceInstanceSummary[]> => [],
					enabled: false,
				}),
			{
				wrapper: wrapper(client),
			},
		);
		const mutation = renderHook(() => useVerifyServiceIdentityMutation(), {
			wrapper: wrapper(client),
		});

		mutation.result.current.mutate({
			id: "plex-1",
			confirmationDigest: "a".repeat(64),
			expectedConnectionGeneration: 4,
			expectedIdentityGeneration: 2,
		});

		await waitFor(() =>
			expect(consumer.result.current.data?.[0]?.identity.status).toBe("verified"),
		);
		expect(invalidateQueries).toHaveBeenCalledWith({ queryKey: serviceKeys.all });
		expect(invalidateQueries).toHaveBeenCalledWith({ queryKey: trashCacheKeys.cacheHealth });
		expect(invalidateQueries).toHaveBeenCalledWith({ queryKey: plexKeys.cacheHealth() });
		expect(invalidateQueries).toHaveBeenCalledWith({ queryKey: jellyfinKeys.cacheHealth() });
		expect(invalidateQueries).toHaveBeenCalledWith({ queryKey: plexKeys.all });
		expect(invalidateQueries).toHaveBeenCalledWith({ queryKey: jellyfinKeys.all });
		expect(invalidateQueries).toHaveBeenCalledWith({ queryKey: tautulliKeys.all });
		expect(invalidateQueries).toHaveBeenCalledWith({ queryKey: libraryCleanupKeys.status });
		expect(invalidateQueries).toHaveBeenCalledWith({ queryKey: libraryCleanupKeys.approvals });
		client.clear();
	});

	it("updates the service cache and invalidates provider roots after replacement", async () => {
		const client = new QueryClient({ defaultOptions: { mutations: { retry: false } } });
		client.setQueryData(serviceKeys.all, [unverifiedService]);
		const invalidateQueries = vi.spyOn(client, "invalidateQueries");
		const replaced = {
			...unverifiedService,
			identity: {
				status: "verified" as const,
				kind: "jellyfin-server-id",
				fingerprint: "111111111111",
				verifiedAt: "2026-08-14T01:00:00.000Z",
				lastCheckedAt: "2026-08-14T01:00:00.000Z",
			},
		};
		vi.mocked(servicesApi.replaceServiceIdentity).mockResolvedValue(replaced);
		const mutation = renderHook(() => useReplaceServiceIdentityMutation(), {
			wrapper: wrapper(client),
		});
		mutation.result.current.mutate({
			id: "plex-1",
			payload: { label: "Replacement" },
			confirmationDigest: "a".repeat(64),
			expectedConnectionGeneration: 4,
			expectedIdentityGeneration: 2,
		});
		await waitFor(() =>
			expect(
				client.getQueryData<ServiceInstanceSummary[]>(serviceKeys.all)?.[0]?.identity.fingerprint,
			).toBe("111111111111"),
		);
		expect(invalidateQueries).toHaveBeenCalledWith({ queryKey: plexKeys.all });
		expect(invalidateQueries).toHaveBeenCalledWith({ queryKey: jellyfinKeys.all });
		expect(invalidateQueries).toHaveBeenCalledWith({ queryKey: tautulliKeys.all });
		expect(invalidateQueries).toHaveBeenCalledWith({ queryKey: libraryCleanupKeys.approvals });
		client.clear();
	});
});
