import type { MultiInstanceSearchResponse, SearchResult } from "@arr/shared";
import { QueryClient, QueryClientProvider } from "@tanstack/react-query";
import { act, cleanup, fireEvent, render, screen, waitFor, within } from "@testing-library/react";
import type { ReactNode } from "react";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { IncognitoProvider } from "../../../../contexts/IncognitoContext";
import { ColorThemeProvider } from "../../../../providers/color-theme-provider";
import { SearchClient } from "../search-client";

// Framework navigation only: all Search components, hooks, query and API code are real.
vi.mock("next/link", () => ({
	default: ({ children, href }: { children: ReactNode; href: string }) => (
		<a href={href}>{children}</a>
	),
}));
const indexers = [
	{
		id: 7,
		name: "Alpha Seven",
		enable: true,
		protocol: "torrent",
		instanceId: "p-1",
		instanceName: "Alpha",
	},
	{
		id: 8,
		name: "Alpha Eight",
		enable: true,
		protocol: "usenet",
		instanceId: "p-1",
		instanceName: "Alpha",
	},
	{
		id: 7,
		name: "Beta Seven",
		enable: true,
		protocol: "torrent",
		instanceId: "p-2",
		instanceName: "Beta",
	},
];
const base: SearchResult = {
	id: "atlas",
	guid: "atlas",
	title: "Atlas",
	indexer: "Alpha Seven",
	indexerId: 7,
	protocol: "torrent",
	instanceId: "p-1",
	instanceName: "Alpha",
	size: 100,
	seeders: 10,
	leechers: 0,
	ageHours: 2,
	rejected: false,
};
const rows: SearchResult[] = [
	base,
	{ ...base, id: "birch", guid: "birch", title: "Birch", size: 200, seeders: 5, ageHours: 4 },
	{ ...base, id: "old", guid: "old", title: "Old", seeders: 8, ageHours: 100 },
	{
		...base,
		id: "rejected",
		guid: "rejected",
		title: "Rejected",
		seeders: 9,
		ageHours: 1,
		rejected: true,
		rejectionReasons: ["Synthetic rejection"],
	},
	{
		...base,
		id: "usenet",
		guid: "usenet",
		title: "Usenet",
		protocol: "usenet",
		seeders: 7,
		ageHours: 1,
	},
	{ ...base, id: "zero", guid: "zero", title: "Zero", size: 0, seeders: 0, ageHours: 0 },
	{
		id: "unknown",
		guid: "unknown",
		title: "Unknown",
		indexer: "Alpha Seven",
		indexerId: 7,
		protocol: "torrent",
		instanceId: "p-1",
		instanceName: "Alpha",
		metadataIncomplete: true,
	},
];
// Literal 26-row inventory crosses the actual default page boundary (25).
const pageRows: SearchResult[] = [
	["01", "Page 01"],
	["02", "Page 02"],
	["03", "Page 03"],
	["04", "Page 04"],
	["05", "Page 05"],
	["06", "Page 06"],
	["07", "Page 07"],
	["08", "Page 08"],
	["09", "Page 09"],
	["10", "Page 10"],
	["11", "Page 11"],
	["12", "Page 12"],
	["13", "Page 13"],
	["14", "Page 14"],
	["15", "Page 15"],
	["16", "Page 16"],
	["17", "Page 17"],
	["18", "Page 18"],
	["19", "Page 19"],
	["20", "Page 20"],
	["21", "Page 21"],
	["22", "Page 22"],
	["23", "Page 23"],
	["24", "Page 24"],
	["25", "Page 25"],
	["26", "Page 26"],
].map(([id, title]) => ({ ...base, id: id!, guid: id!, title: title! }));
function batch(data: SearchResult[], failed = false): MultiInstanceSearchResponse {
	const coverage = {
		receivedCount: data.length,
		acceptedCount: data.length,
		rejectedCount: 0,
		metadataIncompleteCount: data.filter((row) => row.metadataIncomplete).length,
	};
	return {
		instances: [
			{
				instanceId: "p-1",
				instanceName: "Alpha",
				success: !failed,
				data,
				...(failed ? {} : { coverage }),
			},
		],
		aggregated: data,
		totalCount: data.length,
		failedInstanceCount: failed ? 1 : 0,
		...(failed ? {} : { coverage }),
	};
}
let queryClient: QueryClient;
let reply: MultiInstanceSearchResponse;
let status: number;
let requests: unknown[];
let unexpected: string[];
let pending: Promise<void> | undefined;
const json = (data: unknown, code = 200) =>
	new Response(JSON.stringify(data), {
		status: code,
		headers: { "Content-Type": "application/json" },
	});
beforeEach(() => {
	window.localStorage.clear();
	requests = [];
	unexpected = [];
	status = 200;
	pending = undefined;
	reply = batch([base]);
	queryClient = new QueryClient({
		defaultOptions: { queries: { retry: false }, mutations: { retry: false } },
	});
	vi.stubGlobal("fetch", async (path: string, init: RequestInit) => {
		if (path === "/api/search/indexers" && init.method === "GET")
			return json({
				instances: [
					{ instanceId: "p-1", instanceName: "Alpha", success: true, data: indexers.slice(0, 2) },
					{ instanceId: "p-2", instanceName: "Beta", success: true, data: indexers.slice(2) },
				],
				aggregated: indexers,
				totalCount: 3,
				failedInstanceCount: 0,
			});
		if (path === "/api/search/query" && init.method === "POST") {
			requests.push(JSON.parse(String(init.body)));
			await pending;
			return json(status === 200 ? reply : { message: "Synthetic search unavailable" }, status);
		}
		unexpected.push(`${init.method} ${path}`);
		throw new Error("Unexpected synthetic request");
	});
});
afterEach(() => {
	cleanup();
	queryClient.clear();
	vi.unstubAllGlobals();
	vi.restoreAllMocks();
	expect(unexpected).toEqual([]);
});
const input = () => screen.getByPlaceholderText("Search for movies, series, music, or books");
const changeQuery = (value: string) => fireEvent.change(input(), { target: { value } });
const change = (element: HTMLElement, value: string) =>
	fireEvent.change(element, { target: { value } });
const protocol = () => screen.getAllByRole("combobox")[0]!;
const sort = () => screen.getAllByRole("combobox")[1]!;
const minSeeders = () => screen.getByPlaceholderText("0");
const maxAge = () => screen.getByPlaceholderText("72");
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
	await screen.findByRole("button", { name: "Alpha Seven" });
	expect(requests).toHaveLength(0);
	changeQuery("synthetic");
}
async function submit() {
	fireEvent.click(screen.getByRole("button", { name: "Search" }));
	await waitFor(() => expect(screen.getByRole("button", { name: "Search" })).not.toBeDisabled());
}
function titles() {
	const table = screen.queryByRole("table");
	return table
		? Array.from(
				table.querySelectorAll("tbody tr"),
				(row) => row.querySelector("td span")?.textContent,
			)
		: [];
}
function expectRange(value: string) {
	expect(
		screen.getAllByText((_, node) => node?.tagName === "SPAN" && node.textContent === value),
	).toHaveLength(2);
}

describe("composed Search interactions through synthetic HTTP", () => {
	// Catches missing form guards, crossed instance/indexer IDs, untrimmed query and duplicate submit.
	it("guards invalid submissions and sends the chosen coordinates/type once while pending", async () => {
		await mount();
		changeQuery("   ");
		await submit();
		expect(screen.getByText("Enter a search query first.")).toBeInTheDocument();
		expect(requests).toHaveLength(0);
		changeQuery("  literal query  ");
		for (const clear of screen.getAllByRole("button", { name: "Clear" })) fireEvent.click(clear);
		await submit();
		expect(screen.getByText("Select at least one indexer to search against.")).toBeInTheDocument();
		expect(requests).toHaveLength(0);
		fireEvent.click(screen.getByRole("button", { name: "Alpha Eight" }));
		fireEvent.click(screen.getByRole("button", { name: "Beta Seven" }));
		fireEvent.click(screen.getByRole("button", { name: "Series" }));
		let release!: () => void;
		pending = new Promise<void>((resolve) => {
			release = resolve;
		});
		fireEvent.click(screen.getByRole("button", { name: "Search" }));
		await waitFor(() => expect(requests).toHaveLength(1));
		const searching = screen.getByRole("button", { name: "Searching..." });
		expect(searching).toBeDisabled();
		fireEvent.click(searching);
		fireEvent.submit(input().closest("form")!);
		await act(async () => Promise.resolve());
		expect(requests).toEqual([
			{
				query: "literal query",
				type: "tv",
				filters: [
					{ instanceId: "p-1", indexerIds: [8] },
					{ instanceId: "p-2", indexerIds: [7] },
				],
			},
		]);
		await act(async () => release());
		await screen.findByText("Atlas");
		expect(requests).toHaveLength(1);
	});
	// Catches disconnected controls, inverted filters/sort and a Reset that loses unknown/zero rows.
	it("filters and sorts retained rows locally and Reset restores every control and unknown distinction", async () => {
		reply = batch(rows);
		await mount();
		await submit();
		await screen.findByText("Atlas");
		expect(titles()).toEqual(["Atlas", "Rejected", "Old", "Usenet", "Birch", "Zero", "Unknown"]);
		const unknown = within(screen.getByText("Unknown", { exact: true }).closest("tr")!);
		expect(unknown.getByText("Seeders Unknown")).toBeInTheDocument();
		expect(
			within(screen.getByText("Zero", { exact: true }).closest("tr")!).getByText("Seeders 0"),
		).toBeInTheDocument();
		change(protocol(), "torrent");
		expect(titles()).toEqual(["Atlas", "Rejected", "Old", "Birch", "Zero", "Unknown"]);
		change(minSeeders(), "1");
		expect(titles()).toEqual(["Atlas", "Rejected", "Old", "Birch"]);
		change(maxAge(), "24");
		expect(titles()).toEqual(["Atlas", "Rejected", "Birch"]);
		fireEvent.click(screen.getByRole("button", { name: "Hide rejected releases" }));
		expect(titles()).toEqual(["Atlas", "Birch"]);
		change(sort(), "size");
		expect(titles()).toEqual(["Birch", "Atlas"]);
		fireEvent.click(screen.getByRole("button", { name: "Asc" }));
		expect(titles()).toEqual(["Atlas", "Birch"]);
		fireEvent.click(screen.getByRole("button", { name: "Reset" }));
		expect(protocol()).toHaveValue("all");
		expect(sort()).toHaveValue("seeders");
		expect(minSeeders()).toHaveValue(null);
		expect(maxAge()).toHaveValue(null);
		expect(screen.getByRole("button", { name: "Hide rejected releases" })).toHaveAttribute(
			"aria-pressed",
			"false",
		);
		expect(screen.getByRole("button", { name: "Desc" })).toHaveAttribute("aria-pressed", "true");
		expect(titles()).toEqual(["Atlas", "Rejected", "Old", "Usenet", "Birch", "Zero", "Unknown"]);
		expect(screen.getByText("Seeders Unknown")).toBeInTheDocument();
		expect(requests).toHaveLength(1);
	});
	// Catches wrong page slices, ignored back/size controls and out-of-range pages after filtering.
	it("pages forward/back and changes page size without another Search", async () => {
		reply = batch(pageRows);
		await mount();
		await submit();
		await screen.findByText("Page 01");
		expect(titles()).toHaveLength(25);
		expect(screen.getByText("Page 25")).toBeInTheDocument();
		expect(screen.queryByText("Page 26")).toBeNull();
		expectRange("Showing 1 to 25 of 26 items");
		fireEvent.click(screen.getAllByTitle("Next page")[0]!);
		expect(titles()).toEqual(["Page 26"]);
		expectRange("Showing 26 to 26 of 26 items");
		fireEvent.click(screen.getAllByTitle("Previous page")[0]!);
		expect(titles()).toHaveLength(25);
		expectRange("Showing 1 to 25 of 26 items");
		fireEvent.click(screen.getAllByTitle("Next page")[0]!);
		const sizes = screen.getAllByRole("combobox").filter((select) => select.id === "page-size");
		change(sizes[1]!, "50");
		expect(titles()).toHaveLength(26);
		expectRange("Showing 1 to 26 of 26 items");
		expect(screen.getAllByTitle("Next page")[0]).toBeDisabled();
		change(sizes[0]!, "25");
		fireEvent.click(screen.getAllByTitle("Next page")[0]!);
		change(minSeeders(), "11");
		expect(titles()).toEqual([]);
		fireEvent.click(screen.getByRole("button", { name: "Reset" }));
		expect(titles()).toHaveLength(25);
		expectRange("Showing 1 to 25 of 26 items");
		expect(requests).toHaveLength(1);
	});
	// Catches filtered-empty being presented as provider absence, or Reset discarding retained positives.
	it("keeps filtered-empty distinct from verified server-empty and unavailable providers", async () => {
		await mount();
		await submit();
		await screen.findByText("Atlas");
		change(minSeeders(), "11");
		expect(
			screen.getByText("No results match the current filters. Adjust them to see more releases."),
		).toBeInTheDocument();
		expect(
			screen.queryByText(
				/No results returned from your indexers|results from unavailable instances are unknown/,
			),
		).toBeNull();
		expect(requests).toHaveLength(1);
		fireEvent.click(screen.getByRole("button", { name: "Reset" }));
		expect(screen.getByText("Atlas")).toBeInTheDocument();
		expect(requests).toHaveLength(1);
		reply = batch([]);
		await submit();
		expect(
			screen.getByText("No results returned from your indexers for that query."),
		).toBeInTheDocument();
		expect(screen.queryByText(/No results match the current filters/)).toBeNull();
		reply = batch([], true);
		await submit();
		expect(
			screen.getByText(
				"Search coverage is incomplete; results from unavailable instances are unknown.",
			),
		).toBeInTheDocument();
		expect(
			screen.queryByText(
				/No results returned from your indexers|No results match the current filters/,
			),
		).toBeNull();
		expect(requests).toHaveLength(3);
	});
	// Catches a failed new search leaving stale rows/success/coverage or replaying without deliberate Search.
	it("clears the previous successful search on failure and recovers only on explicit later Search", async () => {
		reply = batch([base, rows[6]!]);
		await mount();
		await submit();
		await screen.findByText("Atlas");
		expect(screen.getByText(/1 result with incomplete metadata/)).toBeInTheDocument();
		changeQuery("later query");
		status = 503;
		await submit();
		expect(screen.getByText("Synthetic search unavailable")).toBeInTheDocument();
		expect(titles()).toEqual([]);
		expect(
			screen.getByText("Submit a manual search to see results across your indexers."),
		).toBeInTheDocument();
		expect(
			screen.queryByText(
				/Found \d+ result|incomplete metadata|No results returned from your indexers/,
			),
		).toBeNull();
		expect(input()).toHaveValue("later query");
		expect(requests).toHaveLength(2);
		status = 200;
		reply = batch([{ ...base, id: "recovered", guid: "recovered", title: "Recovered" }]);
		changeQuery("recovery query");
		await act(async () => Promise.resolve());
		expect(requests).toHaveLength(2);
		expect(screen.queryByText("Recovered")).toBeNull();
		await submit();
		await screen.findByText("Recovered");
		expect(screen.getByText("Found 1 result.")).toBeInTheDocument();
		expect(screen.queryByText("Atlas")).toBeNull();
		expect(screen.queryByText("Synthetic search unavailable")).toBeNull();
		expect(requests).toHaveLength(3);
		expect(requests[2]).toEqual({
			query: "recovery query",
			type: "movie",
			filters: [
				{ instanceId: "p-1", indexerIds: [7, 8] },
				{ instanceId: "p-2", indexerIds: [7] },
			],
		});
	});
});
