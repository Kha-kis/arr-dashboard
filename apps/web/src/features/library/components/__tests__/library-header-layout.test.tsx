import { fireEvent, render, screen } from "@testing-library/react";
import { describe, expect, it, vi } from "vitest";
import { IncognitoProvider } from "../../../../contexts/IncognitoContext";
import { ColorThemeProvider } from "../../../../providers/color-theme-provider";
import type { SyncStatus } from "../../hooks/use-library-data";

vi.mock("../../../../hooks/api/usePlex", () => ({
	usePlexSections: () => ({ data: undefined }),
	usePlexAccounts: () => ({ data: undefined }),
	usePlexScanMutation: () => ({ isPending: false, mutate: vi.fn() }),
}));

import { LibraryHeader } from "../library-header";

function renderHeader(
	options: { syncStatus?: SyncStatus | null; isSyncing?: boolean; hasSyncError?: boolean } = {},
) {
	const onServiceFilterChange = vi.fn();
	render(
		<ColorThemeProvider>
			<IncognitoProvider>
				<LibraryHeader
					serviceFilter="all"
					onServiceFilterChange={onServiceFilterChange}
					instanceFilter="all"
					onInstanceFilterChange={vi.fn()}
					statusFilter="all"
					onStatusFilterChange={vi.fn()}
					fileFilter="all"
					onFileFilterChange={vi.fn()}
					qualityFilter="all"
					onQualityFilterChange={vi.fn()}
					torrentStateFilter="all"
					onTorrentStateFilterChange={vi.fn()}
					searchTerm=""
					onSearchTermChange={vi.fn()}
					sortBy="sortTitle"
					onSortByChange={vi.fn()}
					sortOrder="asc"
					onSortOrderChange={vi.fn()}
					instanceOptions={[]}
					syncStatus={options.syncStatus ?? null}
					isSyncing={options.isSyncing ?? false}
					hasSyncError={options.hasSyncError ?? false}
				/>
			</IncognitoProvider>
		</ColorThemeProvider>,
	);
	return { onServiceFilterChange };
}

describe("Library service filter layout", () => {
	it("wraps all service controls rather than requiring horizontal scrolling", () => {
		renderHeader();
		const controls = screen.getAllByRole("button", {
			name: /^(All|Movies|Series|Artists|Authors)$/,
		});
		expect(controls).toHaveLength(5);
		const strip = controls[0]?.parentElement;
		expect(controls.every((control) => control.parentElement === strip)).toBe(true);
		// JSDOM cannot prove geometry; populated browser QA separately measures it.
		expect(strip).toHaveClass("flex-wrap", "max-w-full");
		expect(strip).not.toHaveClass("overflow-x-auto");
	});

	it("retains the existing service selection values", () => {
		const { onServiceFilterChange } = renderHeader();
		fireEvent.click(screen.getByRole("button", { name: "Authors" }));
		expect(onServiceFilterChange).toHaveBeenCalledExactlyOnceWith("readarr");
	});

	it("labels idle cached counts as last known and shows only a generic sync warning", () => {
		renderHeader({
			syncStatus: {
				isCached: true,
				lastSync: "2026-09-27T20:00:00Z",
				syncInProgress: false,
				totalCachedItems: 1559,
			},
			hasSyncError: true,
		});

		expect(screen.getByText(/Last known/)).toHaveTextContent("1,559 items");
		expect(screen.getByText("Sync unavailable")).toBeInTheDocument();
		expect(screen.queryByText("Syncing...")).not.toBeInTheDocument();
		expect(screen.queryByText(/private provider detail/i)).not.toBeInTheDocument();
	});

	it("does not portray a missing cache as a last-known zero-item library", () => {
		renderHeader({
			syncStatus: {
				isCached: false,
				lastSync: null,
				syncInProgress: false,
				totalCachedItems: 0,
			},
		});

		expect(screen.getByText("Cache unavailable")).toBeInTheDocument();
		expect(screen.queryByText(/Last known/)).not.toBeInTheDocument();
	});
});
