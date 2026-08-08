import { QueryClient, QueryClientProvider } from "@tanstack/react-query";
import { renderHook, waitFor } from "@testing-library/react";
import type { ReactNode } from "react";
import { beforeEach, describe, expect, it, vi } from "vitest";
import { deploymentHistoryKeys } from "../../../lib/query-keys";

vi.mock("../../../lib/api-client/trash-guides", () => ({
	undeployDeployment: vi.fn(),
}));

import * as trashGuidesApi from "../../../lib/api-client/trash-guides";
import { useUndeployDeployment } from "../useDeploymentHistory";

function createWrapper(client: QueryClient) {
	return ({ children }: { children: ReactNode }) => (
		<QueryClientProvider client={client}>{children}</QueryClientProvider>
	);
}

describe("useUndeployDeployment", () => {
	beforeEach(() => {
		vi.clearAllMocks();
	});

	it("keeps an HTTP 200 partial undeploy in the error state and refreshes durable progress", async () => {
		const client = new QueryClient({
			defaultOptions: { mutations: { retry: false }, queries: { retry: false } },
		});
		const invalidateQueries = vi.spyOn(client, "invalidateQueries");
		vi.mocked(trashGuidesApi.undeployDeployment).mockResolvedValue({
			success: false,
			message: "Undeploy partially completed",
			data: {
				deleted: 1,
				deletedCFs: ["First format"],
				restoredCFs: [],
				skippedShared: [],
				errors: ["Second format could not be verified"],
			},
		});
		const { result } = renderHook(() => useUndeployDeployment(), {
			wrapper: createWrapper(client),
		});

		result.current.mutate("history-1");

		await waitFor(() => expect(result.current.isError).toBe(true));
		expect(result.current.isSuccess).toBe(false);
		expect(result.current.error?.message).toContain("Second format could not be verified");
		expect(invalidateQueries).toHaveBeenCalledWith({ queryKey: deploymentHistoryKeys.all });
		expect(invalidateQueries).toHaveBeenCalledWith({
			queryKey: deploymentHistoryKeys.detail("history-1"),
		});

		client.clear();
	});
});
