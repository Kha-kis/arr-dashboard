import { QueryClient, QueryClientProvider } from "@tanstack/react-query";
import { renderHook, waitFor } from "@testing-library/react";
import type { ReactNode } from "react";
import { beforeEach, describe, expect, it, vi } from "vitest";
import { systemKeys } from "../../../lib/query-keys";

vi.mock("../../../lib/api-client/system");
vi.mock("sonner", () => ({ toast: { success: vi.fn(), error: vi.fn() } }));

import * as systemApi from "../../../lib/api-client/system";
import { useUpdateSystemSettings } from "../useSystem";

function createWrapper(client: QueryClient) {
	return ({ children }: { children: ReactNode }) => (
		<QueryClientProvider client={client}>{children}</QueryClientProvider>
	);
}

describe("useUpdateSystemSettings", () => {
	beforeEach(() => {
		vi.clearAllMocks();
	});

	it("invalidates settings and security posture after a successful save", async () => {
		const client = new QueryClient({
			defaultOptions: { mutations: { retry: false }, queries: { retry: false } },
		});
		const invalidateQueries = vi.spyOn(client, "invalidateQueries");
		vi.mocked(systemApi.updateSystemSettings).mockResolvedValue({
			success: true,
			message: "Settings saved",
			data: {},
		} as never);

		const { result } = renderHook(() => useUpdateSystemSettings(), {
			wrapper: createWrapper(client),
		});

		result.current.mutate({ externalUrl: "https://arr.example.com" });

		await waitFor(() => expect(result.current.isSuccess).toBe(true));
		expect(invalidateQueries).toHaveBeenCalledWith({ queryKey: systemKeys.settings });
		expect(invalidateQueries).toHaveBeenCalledWith({ queryKey: systemKeys.securityPosture });

		client.clear();
	});
});
