import type { CrossSeedDiscoveryItem, CrossSeedDiscoveryResponse } from "@arr/shared";
import { QueryClient, QueryClientProvider } from "@tanstack/react-query";
import { act, fireEvent, render, screen } from "@testing-library/react";
import { beforeEach, describe, expect, it, vi } from "vitest";
import { IncognitoProvider, useIncognitoMode } from "../../../../contexts/IncognitoContext";
import { ColorThemeProvider } from "../../../../providers/color-theme-provider";

const useCrossSeedDiscovery = vi.fn();
const useCrossSeedAvailability = vi.fn();

// Query-result doubles isolate coverage rendering; recovery is exercised with
// the real hooks, API client and providers in cross-seed-discovery-recovery.
vi.mock("../../../../hooks/api/useQui", () => ({
	useCrossSeedAvailability: () => useCrossSeedAvailability(),
	useCrossSeedDiscovery: (...args: unknown[]) => useCrossSeedDiscovery(...args),
	useTrackerIcons: () => ({ data: { trackers: {} } }),
}));
vi.mock("../../../../hooks/api/useServicesQuery", () => ({
	useServicesQuery: () => ({ data: [] }),
}));

import { CrossSeedClient } from "../cross-seed-client";

const item: CrossSeedDiscoveryItem = {
	libraryCacheId: "lib-1",
	arrInstanceId: "arr-1",
	arrInstanceLabel: "Synthetic Sonarr",
	arrService: "sonarr",
	itemType: "series",
	arrItemId: 42,
	title: "Synthetic Show",
	year: 2024,
	primary: {
		hash: "aaaa",
		qbitInstanceId: 1,
		qbitInstanceName: "Synthetic qbit",
		state: "uploading",
		ratio: 1.5,
		tracker: null,
	},
	siblings: [
		{
			hash: "bbbb",
			name: "Synthetic sibling",
			instanceId: 1,
			instanceName: "Synthetic qbit",
			state: "uploading",
			progress: 1,
			size: 1024,
			category: "",
			savePath: "/synthetic",
			contentPath: "/synthetic/item",
			tracker: "tracker.example",
			matchType: "release",
			tags: "",
		},
	],
};

function page(overrides: Partial<CrossSeedDiscoveryResponse> = {}): CrossSeedDiscoveryResponse {
	return {
		items: [item],
		nextCursor: null,
		scannedThisBatch: 1,
		foundThisBatch: 1,
		totalScanned: 1,
		totalFound: 1,
		exhausted: true,
		quiInstanceLabel: "Synthetic qUI",
		siblingFetchErrors: 0,
		torrentInventoryComplete: true,
		...overrides,
	};
}

function PrivacyToggle() {
	const [enabled, setEnabled] = useIncognitoMode();
	return (
		<button type="button" onClick={() => setEnabled(!enabled)}>
			Toggle privacy
		</button>
	);
}

function renderScan(pages = [page()], overrides: Record<string, unknown> = {}, toggle = false) {
	useCrossSeedDiscovery.mockReturnValue({
		data: { pages },
		hasNextPage: false,
		isFetching: false,
		isError: false,
		fetchNextPage: vi.fn(),
		refetch: vi.fn(),
		...overrides,
	});
	return render(
		<QueryClientProvider
			client={new QueryClient({ defaultOptions: { queries: { retry: false } } })}
		>
			<ColorThemeProvider>
				<IncognitoProvider>
					{toggle ? <PrivacyToggle /> : null}
					<CrossSeedClient />
				</IncognitoProvider>
			</ColorThemeProvider>
		</QueryClientProvider>,
	);
}

describe("CrossSeedClient coverage summary", () => {
	beforeEach(() => {
		localStorage.removeItem("arr-dashboard-incognito-mode");
		useCrossSeedDiscovery.mockReset();
		useCrossSeedAvailability.mockReturnValue({
			data: {
				available: true,
				quiInstanceId: "qui-1",
				quiInstanceLabel: "Synthetic qUI",
				scanCandidates: 1,
			},
			isLoading: false,
			isError: false,
			refetch: vi.fn(),
		});
	});

	it.each(["discovery", "availability"])(
		"masks the %s header instance label when privacy is enabled",
		(source) => {
			localStorage.setItem("arr-dashboard-incognito-mode", "true");
			const { container } = renderScan(
				source === "discovery" ? [page()] : [],
				source === "availability" ? { data: undefined, isLoading: true } : {},
			);
			expect(container.textContent).not.toContain("Synthetic qUI");
			for (const element of container.querySelectorAll("*")) {
				for (const attribute of element.attributes)
					expect(attribute.value).not.toContain("Synthetic qUI");
			}
		},
	);

	it("updates the real header label when privacy toggles in both directions", () => {
		const { container } = renderScan([page()], {}, true);
		expect(container.textContent).toContain("Synthetic qUI");
		fireEvent.click(screen.getByRole("button", { name: "Toggle privacy" }));
		expect(container.textContent).not.toContain("Synthetic qUI");
		fireEvent.click(screen.getByRole("button", { name: "Toggle privacy" }));
		expect(container.textContent).toContain("Synthetic qUI");
	});

	it("updates the real header when privacy changes in another tab", () => {
		const { container } = renderScan();
		act(() => {
			window.dispatchEvent(
				new StorageEvent("storage", { key: "arr-dashboard-incognito-mode", newValue: "true" }),
			);
		});
		expect(container.textContent).not.toContain("Synthetic qUI");
		act(() => {
			window.dispatchEvent(
				new StorageEvent("storage", { key: "arr-dashboard-incognito-mode", newValue: "false" }),
			);
		});
		expect(container.textContent).toContain("Synthetic qUI");
	});

	it("retains the real sibling card when sibling lookups failed", () => {
		renderScan([page({ siblingFetchErrors: 1 })]);
		expect(screen.getByText("Unreachable")).toBeInTheDocument();
		expect(screen.getByRole("heading", { name: /Synthetic Show/ })).toBeInTheDocument();
		expect(screen.queryByText("Healthy")).not.toBeInTheDocument();
		expect(screen.queryByText("Scan complete")).not.toBeInTheDocument();
		expect(screen.getByRole("button", { name: /retry scan/i })).toBeInTheDocument();
	});

	it("withholds completion while more batches remain", () => {
		renderScan([page({ exhausted: false, nextCursor: "lib-1" })], { hasNextPage: true });
		expect(screen.queryByText("Scan complete")).not.toBeInTheDocument();
		expect(screen.queryByText("No reported tracker problems")).not.toBeInTheDocument();
	});

	it("reports only absence of reported tracker problems for verified completed coverage", () => {
		renderScan();
		expect(screen.getByText("No reported tracker problems")).toBeInTheDocument();
		expect(screen.getByText("Scan complete")).toBeInTheDocument();
		expect(screen.queryByText("Healthy")).not.toBeInTheDocument();
	});

	it.each([false, undefined])(
		"keeps positive rows usable with inventory coverage %s",
		(torrentInventoryComplete) => {
			renderScan([page({ torrentInventoryComplete })]);
			expect(screen.getByRole("heading", { name: /Synthetic Show/ })).toBeInTheDocument();
			expect(screen.getByText("Coverage unverified")).toBeInTheDocument();
			expect(screen.queryByText("Scan complete")).not.toBeInTheDocument();
		},
	);

	it("requires coverage evidence from every page", () => {
		renderScan([
			page({ items: [], torrentInventoryComplete: false, exhausted: false, nextCursor: "lib-0" }),
			page(),
		]);
		expect(screen.getByText("Coverage unverified")).toBeInTheDocument();
		expect(screen.queryByText("Scan complete")).not.toBeInTheDocument();
	});

	it("does not infer absence when all sibling reads fail", () => {
		renderScan([page({ items: [], foundThisBatch: 0, siblingFetchErrors: 1 })]);
		expect(screen.getByText(/Some sibling lookups failed/)).toBeInTheDocument();
		expect(screen.queryByText("No cross-seed siblings found")).not.toBeInTheDocument();
		expect(screen.queryByText("Scan complete")).not.toBeInTheDocument();
	});

	it("does not infer absence from exhausted but unverified inventory", () => {
		renderScan([page({ items: [], foundThisBatch: 0, torrentInventoryComplete: false })]);
		expect(screen.getByText("Coverage unverified")).toBeInTheDocument();
		expect(screen.queryByText("No cross-seed siblings found")).not.toBeInTheDocument();
	});

	it("shows an empty result only for verified successful coverage", () => {
		renderScan([page({ items: [], foundThisBatch: 0 })]);
		expect(screen.getByText("No cross-seed siblings found")).toBeInTheDocument();
		expect(screen.getByText("Scan complete")).toBeInTheDocument();
	});

	it("offers a generic availability retry without disclosing diagnostics", () => {
		const refetch = vi.fn();
		useCrossSeedAvailability.mockReturnValue({
			isLoading: false,
			isError: true,
			error: new Error("private provider diagnostic"),
			refetch,
		});
		const { container } = renderScan([]);
		expect(container.textContent).not.toContain("private provider diagnostic");
		expect(screen.getByRole("button", { name: /retry availability/i })).toBeEnabled();
	});

	it("offers a generic initial scan retry without claiming completion", () => {
		const refetch = vi.fn();
		const { container } = renderScan([], {
			data: undefined,
			isError: true,
			error: new Error("private provider diagnostic"),
			refetch,
		});
		expect(container.textContent).not.toContain("private provider diagnostic");
		expect(screen.queryByText("No cross-seed siblings found")).not.toBeInTheDocument();
		expect(screen.queryByText("Scan complete")).not.toBeInTheDocument();
		expect(screen.getByRole("button", { name: /retry scan/i })).toBeEnabled();
	});
});
