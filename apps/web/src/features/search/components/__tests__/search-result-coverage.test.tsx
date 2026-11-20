import { QueryClient, QueryClientProvider } from "@tanstack/react-query";
import { act, cleanup, fireEvent, render, screen, waitFor, within } from "@testing-library/react";
import type { ReactNode } from "react";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { IncognitoProvider } from "../../../../contexts/IncognitoContext";
import { ColorThemeProvider } from "../../../../providers/color-theme-provider";
import { SearchClient } from "../search-client";

// Only the framework adapter is replaced; hooks, query, admission, and table are real.
vi.mock("next/link", () => ({
	default: ({ children, href }: { children: ReactNode; href: string }) => (
		<a href={href}>{children}</a>
	),
}));
const row = {
	id: "release",
	guid: "release",
	title: "Synthetic Release",
	indexer: "Synthetic Indexer",
	indexerId: 7,
	protocol: "torrent",
	instanceId: "p-1",
	instanceName: "Synthetic Prowlarr",
};
const complete = {
	receivedCount: 0,
	acceptedCount: 0,
	rejectedCount: 0,
	metadataIncompleteCount: 0,
};
const indexer = {
	id: 7,
	name: "Synthetic Indexer",
	enable: true,
	protocol: "torrent",
	instanceId: "p-1",
	instanceName: "Synthetic Prowlarr",
};
function batch(rows: unknown[], coverage?: typeof complete, failed = 0) {
	return {
		instances: [
			{
				instanceId: "p-1",
				instanceName: "Synthetic Prowlarr",
				success: failed === 0,
				data: rows,
				...(coverage ? { coverage } : {}),
			},
		],
		aggregated: rows,
		totalCount: rows.length,
		failedInstanceCount: failed,
		...(coverage ? { coverage } : {}),
	};
}
let reply: unknown;
let queryClient: QueryClient;
let searchReads: number;
let unexpected: string[];

beforeEach(() => {
	window.localStorage.clear();
	searchReads = 0;
	unexpected = [];
	reply = batch([], complete);
	queryClient = new QueryClient({
		defaultOptions: { queries: { retry: false }, mutations: { retry: false } },
	});
	vi.stubGlobal("fetch", async (path: string, init: RequestInit) => {
		let data: unknown;
		if (path === "/api/search/indexers" && init.method === "GET")
			data = {
				instances: [
					{ instanceId: "p-1", instanceName: "Synthetic Prowlarr", success: true, data: [indexer] },
				],
				aggregated: [indexer],
				totalCount: 1,
				failedInstanceCount: 0,
			};
		else if (path === "/api/search/query" && init.method === "POST") {
			searchReads++;
			expect(JSON.parse(String(init.body))).toEqual({
				query: "synthetic",
				type: "movie",
				filters: [{ instanceId: "p-1", indexerIds: [7] }],
			});
			data = reply;
		} else {
			unexpected.push(`${init.method} ${path}`);
			throw new Error("Unexpected synthetic request");
		}
		return new Response(JSON.stringify(data), { headers: { "Content-Type": "application/json" } });
	});
});
afterEach(() => {
	cleanup();
	queryClient.clear();
	vi.unstubAllGlobals();
	vi.restoreAllMocks();
	expect(unexpected).toEqual([]);
});
async function mount() {
	render(
		<QueryClientProvider client={queryClient}>
			<ColorThemeProvider>
				<IncognitoProvider>
					<SearchClient />
				</IncognitoProvider>
			</ColorThemeProvider>
		</QueryClientProvider>,
	);
	await screen.findByPlaceholderText("Search for movies, series, music, or books");
	fireEvent.change(screen.getByPlaceholderText("Search for movies, series, music, or books"), {
		target: { value: "synthetic" },
	});
	expect(searchReads).toBe(0);
}
async function submit() {
	fireEvent.click(screen.getByRole("button", { name: "Search" }));
	await waitFor(() => expect(screen.getByRole("button", { name: "Search" })).not.toBeDisabled());
}

describe("real mounted SearchClient returned-batch coverage", () => {
	it.each([false, true])(
		"preserves available rows and warns about rejected data, incognito=%s",
		async (incognito) => {
			if (incognito) window.localStorage.setItem("arr-dashboard-incognito-mode", "true");
			reply = batch([row], {
				receivedCount: 2,
				acceptedCount: 1,
				rejectedCount: 1,
				metadataIncompleteCount: 0,
			});
			await mount();
			await submit();
			await screen.findByText(/1 returned result rejected/);
			const unavailableGrab = screen.getByRole("button", { name: "New search needed" });
			expect(unavailableGrab).toBeDisabled();
			fireEvent.click(unavailableGrab);
			expect(unexpected.filter((request) => request === "POST /api/search/grab")).toHaveLength(0);
			expect(searchReads).toBe(1);
			if (incognito) expect(screen.queryByText("Synthetic Release")).toBeNull();
			else expect(screen.getByText("Synthetic Release")).toBeInTheDocument();
		},
	);
	it.each(["rejected", "legacy"])(
		"does not certify %s empty as no matches and recovers only on explicit Search",
		async (kind) => {
			reply =
				kind === "rejected"
					? batch([], {
							receivedCount: 1,
							acceptedCount: 0,
							rejectedCount: 1,
							metadataIncompleteCount: 0,
						})
					: batch([]);
			await mount();
			await submit();
			await screen.findByText(
				kind === "rejected"
					? /1 returned result rejected/
					: /Returned-batch coverage is unverified/,
			);
			expect(
				screen.getByText(/Search coverage is incomplete; available results may be missing/),
			).toBeInTheDocument();
			expect(
				screen.queryByText(
					/No results returned from your indexers|No results found for that query/,
				),
			).toBeNull();
			expect(screen.queryByRole("button", { name: "Grab" })).toBeNull();
			expect(searchReads).toBe(1);
			reply = batch([], complete);
			await act(async () => Promise.resolve());
			expect(searchReads).toBe(1);
			await submit();
			await screen.findByText("No results returned from your indexers for that query.");
			expect(screen.queryByText(/returned result rejected|coverage is unverified/)).toBeNull();
			expect(searchReads).toBe(2);
		},
	);
	it("warns on legacy positive rows while requiring fresh Grab provenance", async () => {
		reply = batch([row]);
		await mount();
		await submit();
		await screen.findByText(/Returned-batch coverage is unverified/);
		expect(screen.getByText("Synthetic Release")).toBeInTheDocument();
		const unavailableGrab = screen.getByRole("button", { name: "New search needed" });
		expect(unavailableGrab).toBeDisabled();
		fireEvent.click(unavailableGrab);
		expect(unexpected.filter((request) => request === "POST /api/search/grab")).toHaveLength(0);
	});
	it("renders unknown metrics distinctly from real zero and labels incomplete row metadata", async () => {
		reply = batch(
			[
				{ ...row, metadataIncomplete: true, downloadVolumeFactor: 0 },
				{ ...row, id: "zero", title: "Zero Release", size: 0, seeders: 0, leechers: 0 },
			],
			{ receivedCount: 2, acceptedCount: 2, rejectedCount: 0, metadataIncompleteCount: 1 },
		);
		await mount();
		await submit();
		await screen.findByText(/1 result with incomplete metadata/);
		const unknownRow = within(screen.getByText("Synthetic Release").closest("tr")!);
		expect(unknownRow.getByText("Size Unknown")).toBeInTheDocument();
		expect(unknownRow.getByText("Seeders Unknown")).toBeInTheDocument();
		expect(unknownRow.getByText("Leechers Unknown")).toBeInTheDocument();
		expect(unknownRow.getByText("Ratio DL 0x / UL Unknown")).toBeInTheDocument();
		expect(unknownRow.getByText("Metadata incomplete")).toBeInTheDocument();
		const zeroRow = within(screen.getByText("Zero Release").closest("tr")!);
		expect(zeroRow.getByText("Size 0 B")).toBeInTheDocument();
		expect(zeroRow.getByText("Seeders 0")).toBeInTheDocument();
		expect(zeroRow.getByText("Leechers 0")).toBeInTheDocument();
	});
	it("keeps unavailable instances distinct and requires explicit recovery", async () => {
		reply = batch([], undefined, 1);
		await mount();
		await submit();
		await screen.findByText(/1 Prowlarr instance unavailable/);
		expect(screen.getByText(/results from unavailable instances are unknown/)).toBeInTheDocument();
		expect(searchReads).toBe(1);
		reply = batch([row], {
			receivedCount: 1,
			acceptedCount: 1,
			rejectedCount: 0,
			metadataIncompleteCount: 0,
		});
		await submit();
		await screen.findByText("Found 1 result.");
		expect(searchReads).toBe(2);
	});
});
