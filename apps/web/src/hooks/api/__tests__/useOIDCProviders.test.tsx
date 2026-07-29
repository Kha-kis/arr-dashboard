import { QueryClient, QueryClientProvider } from "@tanstack/react-query";
import { renderHook, waitFor } from "@testing-library/react";
import type { ReactNode } from "react";
import { beforeEach, describe, expect, it, vi } from "vitest";
import { oidcKeys, systemKeys } from "../../../lib/query-keys";

vi.mock("../../../lib/api-client/oidc-providers");

import * as oidcApi from "../../../lib/api-client/oidc-providers";
import {
	useCreateOIDCProvider,
	useDeleteOIDCProvider,
	useUpdateOIDCProvider,
} from "../useOIDCProviders";

function createWrapper(client: QueryClient) {
	return ({ children }: { children: ReactNode }) => (
		<QueryClientProvider client={client}>{children}</QueryClientProvider>
	);
}

describe("OIDC provider mutations", () => {
	beforeEach(() => {
		vi.clearAllMocks();
	});

	it("invalidates the provider and security posture after create, update, and delete", async () => {
		const client = new QueryClient({
			defaultOptions: { mutations: { retry: false }, queries: { retry: false } },
		});
		const invalidateQueries = vi.spyOn(client, "invalidateQueries");
		vi.mocked(oidcApi.createOIDCProvider).mockResolvedValue({} as never);
		vi.mocked(oidcApi.updateOIDCProvider).mockResolvedValue({} as never);
		vi.mocked(oidcApi.deleteOIDCProvider).mockResolvedValue(undefined);
		const wrapper = createWrapper(client);

		const createMutation = renderHook(() => useCreateOIDCProvider(), { wrapper });
		createMutation.result.current.mutate({
			displayName: "Example",
			clientId: "client-id",
			clientSecret: "secret",
			issuer: "https://issuer.example.com",
			redirectUri: "https://arr.example.com/auth/oidc/callback",
			scopes: "openid,email,profile",
			enabled: true,
		});
		await waitFor(() => expect(createMutation.result.current.isSuccess).toBe(true));

		const updateMutation = renderHook(() => useUpdateOIDCProvider(), { wrapper });
		updateMutation.result.current.mutate({
			redirectUri: "https://arr.example.com/auth/oidc/callback",
		});
		await waitFor(() => expect(updateMutation.result.current.isSuccess).toBe(true));

		const deleteMutation = renderHook(() => useDeleteOIDCProvider(), { wrapper });
		deleteMutation.result.current.mutate({ replacementPassword: "StrongPassword123!" });
		await waitFor(() => expect(deleteMutation.result.current.isSuccess).toBe(true));

		expect(oidcApi.deleteOIDCProvider).toHaveBeenCalledWith({
			replacementPassword: "StrongPassword123!",
		});
		expect(invalidateQueries).toHaveBeenCalledTimes(6);
		expect(invalidateQueries).toHaveBeenCalledWith({ queryKey: oidcKeys.provider });
		expect(invalidateQueries).toHaveBeenCalledWith({ queryKey: systemKeys.securityPosture });

		client.clear();
	});
});
