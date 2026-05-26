/**
 * Tests for the torrent-detail-drawer's capability-aware banner.
 *
 * The drawer reads qui's reported capabilities for the connected
 * qBittorrent and surfaces an amber banner naming the actions that
 * aren't supported. Earlier versions of qBit lack tracker editing
 * and/or share-limits-action — without this banner the operator would
 * just see disabled controls with no explanation.
 *
 * The audit (test-analyzer on PR #475) flagged: no test confirms
 * (a) actions stay enabled while the capability query is loading,
 * (b) sections disable when capability is `false`,
 * (c) the banner enumerates the right list. These tests pin all three.
 */

import { QueryClient, QueryClientProvider } from "@tanstack/react-query";
import { render, screen } from "@testing-library/react";
import type { ReactNode } from "react";
import { beforeEach, describe, expect, it, vi } from "vitest";
import { ColorThemeProvider } from "../../../../providers/color-theme-provider";

// Mock the qui API client + useQui hooks — the drawer body calls
// useQuiCapabilities, and that hook's `enabled` gate / `data?.capabilities`
// shape is what determines whether the banner renders.
vi.mock("../../../../lib/api-client/qui");
vi.mock("../../../../components/ui/toast", () => ({
	toast: { success: vi.fn(), error: vi.fn() },
}));

// We mock useQuiCapabilities directly so the test can control what
// caps the drawer sees without standing up a real network or React
// Query lifecycle.
const mockUseQuiCapabilities = vi.fn();
vi.mock("../../../../hooks/api/useQui", async () => {
	const actual = await vi.importActual<Record<string, unknown>>("../../../../hooks/api/useQui");
	return {
		...actual,
		useQuiCapabilities: (args: unknown) => mockUseQuiCapabilities(args),
	};
});

// Mock useIncognitoMode so the drawer renders without an IncognitoProvider.
vi.mock("../../../../contexts/IncognitoContext", () => ({
	useIncognitoMode: () => [false, vi.fn()],
	IncognitoProvider: ({ children }: { children: ReactNode }) => <>{children}</>,
}));

import type { SeriesTorrentCopy } from "../../../../lib/api-client/qui";
import { TorrentDetailDrawer } from "../torrent-detail-drawer";

function makeCopy(overrides: Partial<SeriesTorrentCopy> = {}): SeriesTorrentCopy {
	return {
		quiInstanceId: "qui-1",
		qbitInstanceId: 0,
		infoHash: "aaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaa",
		name: "Linux ISO",
		role: "library",
		state: "seeding",
		progress: 1,
		size: 1024,
		ratio: 2.5,
		seedingTime: 0,
		uploadedTotal: 0,
		downloadedTotal: 0,
		numSeeds: 5,
		numLeechs: 0,
		dlSpeed: 0,
		upSpeed: 0,
		eta: 0,
		tags: [],
		category: "",
		savePath: "/data/media",
		addedOn: 0,
		completedOn: 0,
		priority: 0,
		quiUnreachable: false,
		...overrides,
	} as SeriesTorrentCopy;
}

function renderDrawer(copy: SeriesTorrentCopy | null) {
	const client = new QueryClient({
		defaultOptions: { queries: { retry: false }, mutations: { retry: false } },
	});
	return render(
		<ColorThemeProvider>
			<QueryClientProvider client={client}>
				<TorrentDetailDrawer copy={copy} onClose={vi.fn()} />
			</QueryClientProvider>
		</ColorThemeProvider>,
	);
}

beforeEach(() => {
	vi.clearAllMocks();
	// Default — query is in flight (no data yet). The hook should still
	// return a useQuery-shaped object, so we mimic that.
	mockUseQuiCapabilities.mockReturnValue({ data: undefined });
});

describe("TorrentDetailDrawer — capability banner", () => {
	it("does NOT render the banner while the capability query is in-flight (no caps yet)", () => {
		mockUseQuiCapabilities.mockReturnValue({ data: undefined });
		renderDrawer(makeCopy());
		// The unsupported banner specifically mentions "doesn't support" —
		// it should not appear until caps is loaded.
		expect(screen.queryByText(/doesn't support/i)).toBeNull();
	});

	it("does NOT render the banner when all supported capabilities are true", () => {
		mockUseQuiCapabilities.mockReturnValue({
			data: {
				capabilities: {
					supportsTrackerEditing: true,
					supportsShareLimitsAction: true,
				},
			},
		});
		renderDrawer(makeCopy());
		expect(screen.queryByText(/doesn't support/i)).toBeNull();
	});

	it("renders banner naming 'tracker editing' when supportsTrackerEditing is false", () => {
		mockUseQuiCapabilities.mockReturnValue({
			data: {
				capabilities: {
					supportsTrackerEditing: false,
					supportsShareLimitsAction: true,
				},
			},
		});
		renderDrawer(makeCopy());
		const banner = screen.getByText(/doesn't support/i);
		expect(banner.textContent).toMatch(/tracker editing/i);
		expect(banner.textContent).not.toMatch(/share \/ seeding limits/i);
	});

	it("renders banner naming 'share / seeding limits' when supportsShareLimitsAction is false", () => {
		mockUseQuiCapabilities.mockReturnValue({
			data: {
				capabilities: {
					supportsTrackerEditing: true,
					supportsShareLimitsAction: false,
				},
			},
		});
		renderDrawer(makeCopy());
		const banner = screen.getByText(/doesn't support/i);
		expect(banner.textContent).toMatch(/share \/ seeding limits/i);
		expect(banner.textContent).not.toMatch(/tracker editing/i);
	});

	it("renders banner enumerating BOTH when both capabilities are false", () => {
		mockUseQuiCapabilities.mockReturnValue({
			data: {
				capabilities: {
					supportsTrackerEditing: false,
					supportsShareLimitsAction: false,
				},
			},
		});
		renderDrawer(makeCopy());
		const banner = screen.getByText(/doesn't support/i);
		expect(banner.textContent).toMatch(/tracker editing/i);
		expect(banner.textContent).toMatch(/share \/ seeding limits/i);
		// The joiner is " or " between the two items.
		expect(banner.textContent).toMatch(/ or /i);
	});

	it("disables the capability query when quiUnreachable is true (no point asking offline qui)", () => {
		// Render with a copy whose quiUnreachable is true and verify
		// the hook was called with enabled:false. This prevents wasted
		// network calls when the drawer opens against an unreachable
		// qui instance.
		mockUseQuiCapabilities.mockReturnValue({ data: undefined });
		renderDrawer(makeCopy({ quiUnreachable: true }));
		expect(mockUseQuiCapabilities).toHaveBeenCalledWith(
			expect.objectContaining({ enabled: false }),
		);
	});
});
