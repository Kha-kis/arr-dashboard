import { QueryClient, QueryClientProvider } from "@tanstack/react-query";
import { renderHook, waitFor } from "@testing-library/react";
import type { ReactNode } from "react";
import { beforeEach, describe, expect, it, vi } from "vitest";
import { ApiError } from "../../../lib/api-client/base";
import { deploymentHistoryKeys, syncKeys, trashGuidesKeys } from "../../../lib/query-keys";

vi.mock("../../../lib/api-client/trash-guides");

import * as trashGuidesApi from "../../../lib/api-client/trash-guides";
import { useExecuteSync } from "../useSync";

function createWrapper(client: QueryClient) {
	return ({ children }: { children: ReactNode }) => (
		<QueryClientProvider client={client}>{children}</QueryClientProvider>
	);
}

describe("useExecuteSync", () => {
	beforeEach(() => {
		vi.clearAllMocks();
	});

	it("invalidates partial server state after a stale execution conflict", async () => {
		const client = new QueryClient({
			defaultOptions: { mutations: { retry: false }, queries: { retry: false } },
		});
		const invalidateQueries = vi.spyOn(client, "invalidateQueries");
		vi.mocked(trashGuidesApi.executeSync).mockRejectedValue(new ApiError("stale", 409));
		const { result } = renderHook(() => useExecuteSync(), { wrapper: createWrapper(client) });

		result.current.mutate({
			templateId: "template-1",
			instanceId: "instance-1",
			syncType: "MANUAL",
			executionToken: "stale-token",
		});

		await waitFor(() => expect(result.current.isError).toBe(true));
		expect(invalidateQueries).toHaveBeenCalledWith({
			queryKey: syncKeys.history("instance-1"),
		});
		expect(invalidateQueries).toHaveBeenCalledWith({
			queryKey: trashGuidesKeys.templates.stats("template-1"),
		});
		expect(invalidateQueries).toHaveBeenCalledWith({
			queryKey: trashGuidesKeys.templates.all,
		});
		expect(invalidateQueries).toHaveBeenCalledWith({
			queryKey: trashGuidesKeys.deployment.preview("template-1", "instance-1"),
		});
		expect(invalidateQueries).toHaveBeenCalledWith({
			queryKey: deploymentHistoryKeys.all,
		});

		client.clear();
	});
});
