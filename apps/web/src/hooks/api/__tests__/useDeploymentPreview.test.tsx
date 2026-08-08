import { QueryClient, QueryClientProvider } from "@tanstack/react-query";
import { renderHook, waitFor } from "@testing-library/react";
import type { ReactNode } from "react";
import { beforeEach, describe, expect, it, vi } from "vitest";
import { ApiError } from "../../../lib/api-client/base";
import {
	deploymentHistoryKeys,
	TEMPLATES_QUERY_KEY,
	trashGuidesKeys,
} from "../../../lib/query-keys";

vi.mock("../../../lib/api-client/trash-guides");

import * as trashGuidesApi from "../../../lib/api-client/trash-guides";
import { useExecuteDeployment } from "../useDeploymentPreview";

const createWrapper =
	(client: QueryClient) =>
	({ children }: { children: ReactNode }) => (
		<QueryClientProvider client={client}>{children}</QueryClientProvider>
	);

describe("useExecuteDeployment", () => {
	beforeEach(() => vi.clearAllMocks());

	it("invalidates all mutation consumers after a partial conflict", async () => {
		const client = new QueryClient({
			defaultOptions: { mutations: { retry: false }, queries: { retry: false } },
		});
		const invalidateQueries = vi.spyOn(client, "invalidateQueries");
		vi.mocked(trashGuidesApi.executeDeployment).mockRejectedValue(
			new ApiError("changed", 409, {
				details: { partialDeployment: { created: 1, updated: 0, skipped: 0 } },
			}),
		);
		const { result } = renderHook(() => useExecuteDeployment(), {
			wrapper: createWrapper(client),
		});

		result.current.mutate({
			templateId: "template-1",
			instanceId: "instance-1",
			executionToken: "stale-token",
		});

		await waitFor(() => expect(result.current.isError).toBe(true));
		expect(invalidateQueries).toHaveBeenCalledWith({
			queryKey: trashGuidesKeys.deployment.preview("template-1", "instance-1"),
		});
		expect(invalidateQueries).toHaveBeenCalledWith({ queryKey: trashGuidesKeys.deployment.all });
		expect(invalidateQueries).toHaveBeenCalledWith({ queryKey: deploymentHistoryKeys.all });
		expect(invalidateQueries).toHaveBeenCalledWith({ queryKey: TEMPLATES_QUERY_KEY });

		client.clear();
	});
});
