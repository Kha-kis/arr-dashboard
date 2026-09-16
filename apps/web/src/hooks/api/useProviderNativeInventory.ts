"use client";

import {
	type ProviderNativeInventoryResponse,
	providerNativeInventoryResponseSchema,
} from "@arr/shared";
import { useQuery } from "@tanstack/react-query";
import { apiRequest } from "../../lib/api-client/base";
import { POLLING_BACKGROUND } from "../../lib/polling-intervals";
import { libraryKeys } from "../../lib/query-keys";

export interface ProviderNativeInventoryQueryOptions {
	instanceId: string | null;
	domain: "library" | "episode";
	afterNativeId?: string | null;
	expectedGenerationId?: string | null;
	refreshKey?: number;
	enabled?: boolean;
}

export function useProviderNativeInventory({
	instanceId,
	domain,
	afterNativeId = null,
	expectedGenerationId = null,
	refreshKey = 0,
	enabled = true,
}: ProviderNativeInventoryQueryOptions) {
	const hasCursor = Boolean(afterNativeId);
	return useQuery<ProviderNativeInventoryResponse>({
		queryKey: libraryKeys.nativeInventory({
			instanceId: instanceId ?? "",
			domain,
			afterNativeId: afterNativeId ?? null,
			expectedGenerationId: expectedGenerationId ?? null,
			refreshKey,
		}),
		queryFn: async () => {
			if (!instanceId) throw new Error("A media server instance is required");
			const search = new URLSearchParams({ instanceId, domain, limit: "100" });
			if (afterNativeId) search.set("afterNativeId", afterNativeId);
			if (expectedGenerationId) search.set("expectedGenerationId", expectedGenerationId);
			const payload = await apiRequest<unknown>(
				`/api/library/provider-inventory?${search.toString()}`,
			);
			return providerNativeInventoryResponseSchema.parse(payload);
		},
		enabled: enabled && Boolean(instanceId),
		refetchInterval: hasCursor ? false : POLLING_BACKGROUND,
		staleTime: hasCursor ? Infinity : POLLING_BACKGROUND,
		placeholderData: undefined,
	});
}
