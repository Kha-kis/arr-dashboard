import type { CrossSeedDiscoveryItem } from "@arr/shared";
import { QueryClient, QueryClientProvider } from "@tanstack/react-query";
import { act, cleanup, fireEvent, render, screen, waitFor } from "@testing-library/react";
import { afterEach, describe, expect, it, vi } from "vitest";
import { IncognitoProvider } from "../../../../contexts/IncognitoContext";
import { quiKeys } from "../../../../lib/query-keys";
import { ColorThemeProvider } from "../../../../providers/color-theme-provider";
import { CrossSeedClient } from "../cross-seed-client";

// Real component/cards/hooks/API base/providers. Only the external HTTP boundary
// is synthetic; every fetch is allowlisted and no network or action is possible.
const availability = {
	available: true,
	quiInstanceId: "qui-1",
	quiInstanceLabel: "Synthetic qUI",
	scanCandidates: 2,
};
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
function batch(overrides: Record<string, unknown> = {}) {
	return {
		items: [],
		nextCursor: null,
		scannedThisBatch: 1,
		foundThisBatch: 0,
		totalScanned: 1,
		totalFound: 0,
		exhausted: true,
		quiInstanceLabel: "Synthetic qUI",
		siblingFetchErrors: 0,
		torrentInventoryComplete: true,
		...overrides,
	};
}
function json(payload: unknown, status = 200) {
	return new Response(JSON.stringify(payload), {
		status,
		headers: { "Content-Type": "application/json" },
	});
}
const clients: QueryClient[] = [];
const deniedReads: string[] = [];
function mount(read: (url: URL) => Response) {
	vi.stubGlobal("fetch", async (path: string, options: RequestInit) => {
		const url = new URL(path, "http://synthetic.test");
		if (
			options.method !== "GET" ||
			options.credentials !== "include" ||
			![
				"/api/qui/cross-seed/availability",
				"/api/qui/cross-seed/discover",
				"/api/qui/tracker-icons",
				"/api/services",
			].includes(url.pathname)
		) {
			deniedReads.push(path);
			throw new Error("Non-allowlisted test request");
		}
		if (url.pathname === "/api/qui/tracker-icons") return json({ trackers: {} });
		if (url.pathname === "/api/services") return json({ services: [] });
		return read(url);
	});
	const client = new QueryClient({
		defaultOptions: { queries: { retry: false, gcTime: 0, refetchOnWindowFocus: false } },
	});
	clients.push(client);
	return render(
		<QueryClientProvider client={client}>
			<ColorThemeProvider>
				<IncognitoProvider>
					<CrossSeedClient />
				</IncognitoProvider>
			</ColorThemeProvider>
		</QueryClientProvider>,
	);
}
function expectNoCompletion() {
	expect(screen.queryByText("Scan complete")).not.toBeInTheDocument();
	expect(screen.queryByText("No cross-seed siblings found")).not.toBeInTheDocument();
	expect(screen.queryByText("No reported tracker problems")).not.toBeInTheDocument();
}
afterEach(() => {
	cleanup();
	for (const client of clients.splice(0)) client.clear();
	vi.unstubAllGlobals();
	expect(deniedReads.splice(0)).toEqual([]);
});

describe("Cross-seed read recovery with real query hooks", () => {
	it("retains positive rows through availability refetch failure and visible retry", async () => {
		let failed = false;
		mount((url) =>
			url.pathname.endsWith("availability")
				? failed
					? json({ message: "private provider diagnostic" }, 503)
					: json(availability)
				: json(batch({ items: [item], foundThisBatch: 1 })),
		);
		await screen.findByText("Scan complete");
		failed = true;
		await act(async () => {
			await clients[clients.length - 1]!.invalidateQueries({
				queryKey: quiKeys.crossSeedAvailability(),
			});
		});
		await screen.findByRole("alert");
		expect(screen.getByRole("heading", { name: /Synthetic Show/ })).toBeInTheDocument();
		expectNoCompletion();
		expect(document.body.textContent).not.toContain("private provider diagnostic");
		failed = false;
		fireEvent.click(screen.getByRole("button", { name: /retry availability/i }));
		await screen.findByText("Scan complete");
		expect(screen.queryByRole("alert")).not.toBeInTheDocument();
		expect(screen.getByRole("heading", { name: /Synthetic Show/ })).toBeInTheDocument();
	});

	it.each(["http", "malformed"])(
		"recovers availability after a %s error using the visible retry",
		async (failure) => {
			let failed = true;
			mount((url) =>
				url.pathname.endsWith("availability")
					? failed
						? json(
								failure === "http"
									? { message: "private provider diagnostic" }
									: { available: true },
								failure === "http" ? 503 : 200,
							)
						: json(availability)
					: json(batch()),
			);
			await waitFor(() => expect(screen.getByRole("alert")).toBeInTheDocument());
			expect(document.body.textContent).not.toContain("private provider diagnostic");
			expectNoCompletion();
			failed = false;
			fireEvent.click(screen.getByRole("button", { name: /retry availability/i }));
			await screen.findByText("No cross-seed siblings found");
			expect(screen.getByText("Scan complete")).toBeInTheDocument();
			expect(screen.queryByRole("alert")).not.toBeInTheDocument();
		},
	);

	it.each(["http", "malformed"])(
		"recovers the initial scan after a %s error without false absence",
		async (failure) => {
			let failed = true;
			mount((url) =>
				url.pathname.endsWith("availability")
					? json(availability)
					: failed
						? json(
								failure === "http"
									? { message: "private provider diagnostic" }
									: { ...batch(), scannedThisBatch: -1 },
								failure === "http" ? 503 : 200,
							)
						: json(batch()),
			);
			await waitFor(() => expect(screen.getByRole("alert")).toBeInTheDocument());
			expect(document.body.textContent).not.toContain("private provider diagnostic");
			expectNoCompletion();
			failed = false;
			fireEvent.click(screen.getByRole("button", { name: /retry scan/i }));
			await screen.findByText("No cross-seed siblings found");
			expect(screen.getByText("Scan complete")).toBeInTheDocument();
			expect(screen.queryByRole("alert")).not.toBeInTheDocument();
		},
	);

	it("retains successful rows through a failed next batch and recovers by retrying its cursor", async () => {
		let failed = true;
		const first = batch({
			items: [item],
			foundThisBatch: 1,
			nextCursor: "lib-1",
			exhausted: false,
		});
		mount((url) =>
			url.pathname.endsWith("availability")
				? json(availability)
				: url.searchParams.get("cursor") === "lib-1"
					? failed
						? json({ message: "private provider diagnostic" }, 503)
						: json(batch())
					: json(first),
		);
		await screen.findByRole("heading", { name: /Synthetic Show/ });
		fireEvent.click(screen.getByRole("button", { name: /scan next 100/i }));
		await screen.findByRole("alert");
		expect(screen.getByRole("heading", { name: /Synthetic Show/ })).toBeInTheDocument();
		expectNoCompletion();
		expect(document.body.textContent).not.toContain("private provider diagnostic");
		failed = false;
		fireEvent.click(screen.getByRole("button", { name: /retry next batch/i }));
		await screen.findByText("Scan complete");
		expect(screen.getByRole("heading", { name: /Synthetic Show/ })).toBeInTheDocument();
		expect(screen.getByText("No reported tracker problems")).toBeInTheDocument();
		expect(screen.queryByRole("alert")).not.toBeInTheDocument();
	});

	it("retries a failed multi-page rescan before advancing the remaining cursor", async () => {
		let phase: "initial" | "failed-rescan" | "recovered" = "initial";
		const secondItem: CrossSeedDiscoveryItem = {
			...item,
			libraryCacheId: "lib-2",
			arrItemId: 43,
			title: "Synthetic second item",
		};
		mount((url) => {
			if (url.pathname.endsWith("availability")) return json(availability);
			const cursor = url.searchParams.get("cursor");
			if (cursor === null) {
				if (phase === "failed-rescan") return json({ message: "private provider diagnostic" }, 503);
				return json(
					batch({
						items: [phase === "recovered" ? { ...item, title: "Revalidated first item" } : item],
						foundThisBatch: 1,
						nextCursor: "lib-1",
						exhausted: false,
					}),
				);
			}
			if (cursor === "lib-1") {
				return json(
					batch({
						items: [
							phase === "recovered"
								? { ...secondItem, title: "Revalidated second item" }
								: secondItem,
						],
						foundThisBatch: 1,
						nextCursor: "lib-2",
						exhausted: false,
					}),
				);
			}
			if (cursor === "lib-2") return json(batch());
			throw new Error("Unexpected synthetic cursor");
		});
		await screen.findByRole("heading", { name: /Synthetic Show/ });
		fireEvent.click(screen.getByRole("button", { name: /scan next 100/i }));
		await screen.findByRole("heading", { name: /Synthetic second item/ });
		phase = "failed-rescan";
		fireEvent.click(screen.getByRole("button", { name: "Rescan" }));
		await screen.findByRole("alert");
		expect(screen.getByRole("heading", { name: /Synthetic Show/ })).toBeInTheDocument();
		expect(screen.getByRole("heading", { name: /Synthetic second item/ })).toBeInTheDocument();
		expectNoCompletion();
		phase = "recovered";
		fireEvent.click(screen.getByRole("button", { name: /retry (?:next batch|scan)/i }));
		await screen.findByRole("heading", { name: /Revalidated first item/ });
		expect(screen.getByRole("heading", { name: /Revalidated second item/ })).toBeInTheDocument();
		expect(screen.queryByRole("alert")).not.toBeInTheDocument();
		expectNoCompletion();
		fireEvent.click(screen.getByRole("button", { name: /scan next 100/i }));
		await screen.findByText("Scan complete");
		expect(screen.getByRole("heading", { name: /Revalidated first item/ })).toBeInTheDocument();
	});

	it("retries partial sibling results and restores verified completion", async () => {
		let failed = true;
		mount((url) =>
			url.pathname.endsWith("availability")
				? json(availability)
				: json(batch({ items: [item], foundThisBatch: 1, siblingFetchErrors: failed ? 1 : 0 })),
		);
		await screen.findByRole("heading", { name: /Synthetic Show/ });
		expect(screen.getByText(/Some sibling lookups failed/)).toBeInTheDocument();
		expectNoCompletion();
		failed = false;
		fireEvent.click(screen.getByRole("button", { name: /retry scan/i }));
		await screen.findByText("Scan complete");
		expect(screen.getByRole("heading", { name: /Synthetic Show/ })).toBeInTheDocument();
		expect(screen.queryByText(/Some sibling lookups failed/)).not.toBeInTheDocument();
	});

	it("keeps legacy positive rows usable and upgrades coverage after a verified rescan", async () => {
		let legacy = true;
		mount((url) =>
			url.pathname.endsWith("availability")
				? json(availability)
				: json(
						batch({
							items: [item],
							foundThisBatch: 1,
							torrentInventoryComplete: legacy ? undefined : true,
						}),
					),
		);
		await screen.findByRole("heading", { name: /Synthetic Show/ });
		expect(screen.getByText("Coverage unverified")).toBeInTheDocument();
		expectNoCompletion();
		legacy = false;
		fireEvent.click(screen.getByRole("button", { name: "Rescan" }));
		await screen.findByText("Scan complete");
		expect(screen.queryByText("Coverage unverified")).not.toBeInTheDocument();
	});
});
