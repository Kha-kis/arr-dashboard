import { QueryClient, QueryClientProvider } from "@tanstack/react-query";
import { act, renderHook, waitFor } from "@testing-library/react";
import type { ReactNode } from "react";
import { beforeEach, describe, expect, it, vi } from "vitest";
import { trashGuidesKeys } from "../../../lib/query-keys";

const apiMocks = vi.hoisted(() => ({
	executeDeployment: vi.fn(),
	executeBulkDeployment: vi.fn(),
}));

vi.mock("../../../lib/api-client/trash-guides", async (importOriginal) => {
	const actual = await importOriginal<typeof import("../../../lib/api-client/trash-guides")>();
	return {
		...actual,
		executeDeployment: apiMocks.executeDeployment,
		executeBulkDeployment: apiMocks.executeBulkDeployment,
	};
});

import { useExecuteBulkDeployment, useExecuteDeployment } from "../useDeploymentPreview";

function createWrapper(queryClient: QueryClient) {
	return function Wrapper({ children }: { children: ReactNode }) {
		return <QueryClientProvider client={queryClient}>{children}</QueryClientProvider>;
	};
}

describe("deployment preview authority recovery", () => {
	beforeEach(() => {
		vi.clearAllMocks();
	});

	it("invalidates the rejected single-instance preview after execution fails", async () => {
		apiMocks.executeDeployment.mockRejectedValue(new Error("stale preview"));
		const queryClient = new QueryClient({
			defaultOptions: { queries: { retry: false }, mutations: { retry: false } },
		});
		const invalidate = vi.spyOn(queryClient, "invalidateQueries");
		const { result } = renderHook(() => useExecuteDeployment(), {
			wrapper: createWrapper(queryClient),
		});

		await act(async () => {
			await result.current
				.mutateAsync({
					templateId: "template-1",
					instanceId: "instance-1",
					executionToken: "a".repeat(64),
				})
				.catch(() => undefined);
		});

		await waitFor(() =>
			expect(invalidate).toHaveBeenCalledWith({
				queryKey: trashGuidesKeys.deployment.preview("template-1", "instance-1"),
			}),
		);
	});

	it("invalidates all reviewed previews after bulk execution fails", async () => {
		apiMocks.executeBulkDeployment.mockRejectedValue(new Error("stale bulk preview"));
		const queryClient = new QueryClient({
			defaultOptions: { queries: { retry: false }, mutations: { retry: false } },
		});
		const invalidate = vi.spyOn(queryClient, "invalidateQueries");
		const { result } = renderHook(() => useExecuteBulkDeployment(), {
			wrapper: createWrapper(queryClient),
		});

		await act(async () => {
			await result.current
				.mutateAsync({
					templateId: "template-1",
					instanceIds: ["instance-1"],
					executionTokens: { "instance-1": "a".repeat(64) },
				})
				.catch(() => undefined);
		});

		await waitFor(() =>
			expect(invalidate).toHaveBeenCalledWith({ queryKey: trashGuidesKeys.deployment.all }),
		);
	});
});
