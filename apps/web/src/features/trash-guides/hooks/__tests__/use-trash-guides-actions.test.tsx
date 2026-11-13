import { act, cleanup, renderHook, screen } from "@testing-library/react";
import type { ReactNode } from "react";
import { Toaster, toast } from "sonner";
import { afterEach, beforeEach, expect, it, vi } from "vitest";
import { IncognitoProvider } from "../../../../contexts/IncognitoContext";
import { useTrashGuidesActions } from "../use-trash-guides-actions";

const mutations = vi.hoisted(() => ({
	refresh: { mutateAsync: vi.fn() },
	remove: { mutateAsync: vi.fn() },
}));
vi.mock("../../../../hooks/api/useTrashCache", () => ({
	useRefreshTrashCache: () => mutations.refresh,
	useDeleteTrashCacheEntry: () => mutations.remove,
}));

function Wrapper({ children }: { children: ReactNode }) {
	return (
		<IncognitoProvider>
			{children}
			<Toaster />
		</IncognitoProvider>
	);
}

beforeEach(() => vi.clearAllMocks());
afterEach(() => {
	toast.dismiss();
	cleanup();
});

it("shows generic failure feedback for a partially failed full refresh", async () => {
	const privateDetail = "synthetic-private-repository-diagnostic";
	mutations.refresh.mutateAsync.mockResolvedValue({
		refreshed: true,
		results: {
			QUALITY_SIZE: { success: true, itemCount: 1 },
			CUSTOM_FORMATS: { success: false, error: privateDetail },
		},
	});
	const { result } = renderHook(() => useTrashGuidesActions(), { wrapper: Wrapper });
	await act(() => result.current.handleRefresh("RADARR"));
	expect(await screen.findByText(/could not be refreshed/i)).toBeVisible();
	expect(screen.queryByText(privateDetail, { exact: false })).toBeNull();
	expect(mutations.refresh.mutateAsync).toHaveBeenCalledExactlyOnceWith({
		serviceType: "RADARR",
		force: true,
	});
	expect(result.current.refreshing).toBeNull();
});

it("does not show failure feedback for successful or lazy-skipped categories", async () => {
	mutations.refresh.mutateAsync.mockResolvedValue({
		refreshed: true,
		results: {
			QUALITY_SIZE: { success: true, itemCount: 0 },
			CF_INCLUDES: { success: true, skipped: true },
		},
	});
	const { result } = renderHook(() => useTrashGuidesActions(), { wrapper: Wrapper });
	await act(() => result.current.handleRefresh("SONARR"));
	expect(screen.queryByText(/could not be refreshed/i)).toBeNull();
	expect(result.current.refreshing).toBeNull();
});

it("still surfaces a rejected single-entry refresh and clears pending state", async () => {
	mutations.refresh.mutateAsync.mockRejectedValue(new Error("Synthetic source unavailable"));
	const { result } = renderHook(() => useTrashGuidesActions(), { wrapper: Wrapper });
	await act(() => result.current.handleRefreshEntry("RADARR", "QUALITY_SIZE"));
	expect(await screen.findByText(/Failed to refresh QUALITY_SIZE cache/i)).toBeVisible();
	expect(result.current.refreshingEntry).toBeNull();
});
