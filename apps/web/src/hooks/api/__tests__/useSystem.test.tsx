import { QueryClient, QueryClientProvider } from "@tanstack/react-query";
import { renderHook, waitFor } from "@testing-library/react";
import type { ReactNode } from "react";
import { beforeEach, describe, expect, it, vi } from "vitest";
import { serviceKeys, systemKeys, tautulliKeys, tracearrKeys } from "../../../lib/query-keys";

vi.mock("../../../lib/api-client/system");
vi.mock("sonner", () => ({ toast: { success: vi.fn(), error: vi.fn() } }));

import * as systemApi from "../../../lib/api-client/system";
import {
	useDismissTautulliProviderNotice,
	useUpdateAnalyticsProviderSelection,
	useUpdateSystemSettings,
} from "../useSystem";

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

describe("useDismissTautulliProviderNotice", () => {
	beforeEach(() => {
		vi.clearAllMocks();
	});

	it("sends the dismissed notice key and invalidates only the notice query", async () => {
		const client = new QueryClient({
			defaultOptions: { mutations: { retry: false }, queries: { retry: false } },
		});
		const invalidateQueries = vi.spyOn(client, "invalidateQueries");
		vi.mocked(systemApi.dismissTautulliProviderNotice).mockResolvedValue({ success: true });

		const { result } = renderHook(() => useDismissTautulliProviderNotice(), {
			wrapper: createWrapper(client),
		});

		result.current.mutate("tautulli-both-configured");

		await waitFor(() => expect(result.current.isSuccess).toBe(true));
		expect(systemApi.dismissTautulliProviderNotice).toHaveBeenCalledWith(
			"tautulli-both-configured",
		);
		expect(invalidateQueries).toHaveBeenCalledTimes(1);
		expect(invalidateQueries).toHaveBeenCalledWith({
			queryKey: systemKeys.tautulliProviderNotices,
		});

		client.clear();
	});
});

describe("useUpdateAnalyticsProviderSelection", () => {
	beforeEach(() => {
		vi.clearAllMocks();
	});

	it("persists an explicit selection and refreshes provider-derived state", async () => {
		const client = new QueryClient({
			defaultOptions: { mutations: { retry: false }, queries: { retry: false } },
		});
		const invalidateQueries = vi.spyOn(client, "invalidateQueries");
		vi.mocked(systemApi.updateAnalyticsProviderSelection).mockResolvedValue({
			selected: "tautulli",
			source: "explicit",
			families: {
				tracearr: { configuredCount: 1, enabledCount: 1 },
				tautulli: { configuredCount: 1, enabledCount: 1 },
			},
			status: "configured",
		});

		const { result } = renderHook(() => useUpdateAnalyticsProviderSelection(), {
			wrapper: createWrapper(client),
		});
		result.current.mutate({ provider: "tautulli" });

		await waitFor(() => expect(result.current.isSuccess).toBe(true));
		expect(systemApi.updateAnalyticsProviderSelection).toHaveBeenCalledWith({
			provider: "tautulli",
		});
		expect(invalidateQueries).toHaveBeenCalledWith({ queryKey: systemKeys.analyticsProvider });
		expect(invalidateQueries).toHaveBeenCalledWith({ queryKey: tracearrKeys.all });
		expect(invalidateQueries).toHaveBeenCalledWith({ queryKey: tautulliKeys.all });
		expect(invalidateQueries).toHaveBeenCalledWith({ queryKey: serviceKeys.all });
		expect(invalidateQueries).toHaveBeenCalledWith({
			queryKey: systemKeys.tautulliProviderNotices,
		});

		client.clear();
	});
});
