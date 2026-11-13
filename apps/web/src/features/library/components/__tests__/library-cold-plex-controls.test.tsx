import type { PlexSectionsResponse } from "@arr/shared";
import { QueryClient, QueryClientProvider } from "@tanstack/react-query";
import { act, cleanup, fireEvent, render, screen, waitFor } from "@testing-library/react";
import { SearchParamsContext } from "next/dist/shared/lib/hooks-client-context.shared-runtime";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { IncognitoProvider } from "../../../../contexts/IncognitoContext";
import { plexKeys } from "../../../../lib/query-keys";
import { ColorThemeProvider } from "../../../../providers/color-theme-provider";
import { LibraryClient } from "../library-client";

// Keep the real parent, Header, service/section hooks and HTTP client. The unrelated
// content/insight/native panels are not part of this cold-control observation.
vi.mock("../library-content", () => ({
	LibraryContent: () => <div>Synthetic library content</div>,
}));
vi.mock("../library-insights-section", () => ({ LibraryInsightsSection: () => null }));
vi.mock("../provider-native-inventory-panel", () => ({
	ProviderNativeInventoryPanel: () => null,
	useProviderNativeInventoryPanelState: () => ({ readSettled: false }),
}));

const section = {
	instanceId: "plex-fixture",
	instanceName: "Synthetic Plex",
	sectionId: "7",
	sectionUuid: "synthetic-section-primary",
	sectionTitle: "Synthetic film library",
	mediaType: "movie",
};
const current: PlexSectionsResponse = {
	sections: [section],
	catalog: { availability: "current", observedAt: "2026-10-31T12:00:00.000Z" },
	evidence: {
		publicationLevel: "authoritative",
		completeness: "complete",
		reasonCodes: [],
		availability: "current",
		authority: "authoritative",
		attemptState: "success",
	},
};
let client: QueryClient;
let plex: "enabled" | "disabled" | "absent";
let sectionStatus: number;
let sections: PlexSectionsResponse;
let sectionWait: Promise<void> | undefined;
let releaseSections: (() => void) | undefined;
let scanStatus: number;
let scanResponse: (() => Response) | undefined;
let scanWait: Promise<void> | undefined;
let releaseScan: (() => void) | undefined;
let calls: { path: string; method: string }[];
let scanBodies: unknown[];
let unexpected: string[];
const reply = (payload: unknown, status = 200) =>
	new Response(JSON.stringify(payload), {
		status,
		headers: { "content-type": "application/json" },
	});
beforeEach(() => {
	localStorage.clear();
	plex = "enabled";
	sectionStatus = 200;
	scanStatus = 200;
	scanResponse = undefined;
	sections = structuredClone(current);
	sectionWait = undefined;
	releaseSections = undefined;
	scanWait = undefined;
	releaseScan = undefined;
	calls = [];
	scanBodies = [];
	unexpected = [];
	client = new QueryClient({
		defaultOptions: {
			queries: { retry: false, retryDelay: 0, gcTime: Infinity },
			mutations: { retry: 2, retryDelay: 0 },
		},
	});
	vi.stubGlobal("fetch", async (input: string, options?: RequestInit) => {
		const url = new URL(input, "http://synthetic.invalid"),
			path = url.pathname,
			method = options?.method ?? "GET";
		calls.push({ path, method });
		if (path === "/api/services")
			return reply({
				services:
					plex === "absent"
						? []
						: [
								...new Map(
									[section, ...sections.sections].map((entry) => [entry.instanceId, entry]),
								).values(),
							].map((entry) => ({
								id: entry.instanceId,
								service: "PLEX",
								enabled: plex === "enabled",
								label: entry.instanceName,
								baseUrl: "http://synthetic.invalid",
								externalUrl: null,
							})),
			});
		if (path === "/api/library")
			return reply({
				items: [],
				pagination: { page: 1, limit: 50, totalItems: 0, totalPages: 0 },
				syncStatus: { isCached: true, syncInProgress: false, totalCachedItems: 0 },
			});
		if (path === "/api/library/sync/status") return reply({ instances: [] });
		if (path === "/api/plex/sections") {
			await sectionWait;
			return sectionStatus === 200
				? reply(sections)
				: reply({ error: "Synthetic section read unavailable" }, sectionStatus);
		}
		if (
			[
				"/api/plex/plex-fixture/sections/7/refresh",
				"/api/plex/plex-secondary/sections/9/refresh",
			].includes(path) &&
			method === "POST"
		) {
			scanBodies.push(JSON.parse(String(options?.body)));
			await scanWait;
			if (scanResponse) return scanResponse();
			return scanStatus === 200
				? reply({ success: true, message: "Synthetic scan acknowledged" })
				: reply({ error: "Synthetic response lost" }, scanStatus);
		}
		if (path === "/api/plex/identity") return reply({ servers: [] });
		if (path === "/api/jellyfin/identity") return reply([]);
		if (path === "/api/qui/tracker-icons") return reply({ trackers: {} });
		if (path === "/api/qui/library-seeding-summary")
			return reply({ status: "not-configured", summaries: {} });
		if (path.endsWith("/watch-enrichment")) return reply({ configured: false, items: {} });
		if (path.endsWith("/series-progress")) return reply({ configured: false, progress: {} });
		unexpected.push(method + " " + path);
		throw new Error("Unexpected synthetic request");
	});
});
afterEach(async () => {
	releaseScan?.();
	releaseSections?.();
	cleanup();
	await client.cancelQueries();
	client.clear();
	vi.unstubAllGlobals();
	expect(unexpected).toEqual([]);
});
function mount() {
	render(
		<QueryClientProvider client={client}>
			<SearchParamsContext.Provider value={new URLSearchParams()}>
				<ColorThemeProvider>
					<IncognitoProvider>
						<LibraryClient />
					</IncognitoProvider>
				</ColorThemeProvider>
			</SearchParamsContext.Provider>
		</QueryClientProvider>,
	);
}
const writes = () => calls.filter((c) => c.method !== "GET");
async function settle() {
	await screen.findByText("Synthetic library content");
	await waitFor(() => expect(client.getQueryState(["services"])?.status).toBe("success"));
}
describe("Library cold Plex controls", () => {
	it.each([
		{ incognito: false, duplicateNames: false },
		{ incognito: true, duplicateNames: false },
		{ incognito: false, duplicateNames: true },
		{ incognito: true, duplicateNames: true },
	])(
		"distinguishes same-title cross-instance scan targets %#",
		async ({ incognito, duplicateNames }) => {
			if (incognito) localStorage.setItem("arr-dashboard-incognito-mode", "true");
			sections = {
				...current,
				sections: [
					{
						...section,
						instanceId: "plex-secondary",
						sectionId: "9",
						sectionUuid: "synthetic-section-secondary",
						instanceName: duplicateNames ? "Synthetic Plex" : "Synthetic secondary Plex",
					},
					section,
				],
			};
			mount();
			fireEvent.click(await screen.findByRole("button", { name: "Scan Plex" }));
			const secondary = screen.getByRole("button", { name: /Plex 2/ });
			expect(screen.getByRole("button", { name: /Plex 1/ })).not.toBe(secondary);
			if (incognito) {
				expect(screen.queryByText("Synthetic Plex")).not.toBeInTheDocument();
				expect(screen.queryByText("Synthetic secondary Plex")).not.toBeInTheDocument();
				expect(screen.queryByText("Synthetic film library")).not.toBeInTheDocument();
			} else {
				expect(secondary).toHaveTextContent(
					duplicateNames ? "Synthetic Plex" : "Synthetic secondary Plex",
				);
			}
			expect(writes()).toEqual([]);
			fireEvent.click(secondary);
			await screen.findByText(/scan requested/i);
			expect(writes()).toEqual([
				{ path: "/api/plex/plex-secondary/sections/9/refresh", method: "POST" },
			]);
			expect(scanBodies).toEqual([{ sectionUuid: "synthetic-section-secondary" }]);
		},
	);
	it.each([
		{
			name: "202 JSON",
			response: () => reply({ success: true, message: "Synthetic acknowledgment" }, 202),
		},
		{ name: "204 empty", response: () => new Response(null, { status: 204 }) },
		{
			name: "200 HTML",
			response: () =>
				new Response("<html>synthetic private diagnostic</html>", {
					status: 200,
					headers: { "content-type": "text/html" },
				}),
		},
		{
			name: "malformed JSON",
			response: () =>
				new Response("{private malformed", {
					status: 200,
					headers: { "content-type": "application/json" },
				}),
		},
		{
			name: "false success",
			response: () => reply({ success: false, message: "Synthetic rejection" }),
		},
		{ name: "missing success", response: () => reply({ message: "Synthetic acknowledgment" }) },
		{
			name: "string success",
			response: () => reply({ success: "true", message: "Synthetic acknowledgment" }),
		},
		{ name: "missing message", response: () => reply({ success: true }) },
		{ name: "invalid message", response: () => reply({ success: true, message: 7 }) },
		{ name: "null body", response: () => reply(null) },
	])("keeps $name scan response unconfirmed without automatic replay", async ({ response }) => {
		scanResponse = response;
		mount();
		fireEvent.click(await screen.findByRole("button", { name: "Scan Plex" }));
		fireEvent.click(await screen.findByRole("button", { name: /Synthetic film library/ }));
		expect(await screen.findByRole("alert")).toHaveTextContent(/not confirmed/i);
		expect(screen.queryByText(/scan requested/i)).not.toBeInTheDocument();
		expect(screen.queryByText(/private diagnostic|private malformed/)).not.toBeInTheDocument();
		expect(writes()).toEqual([
			{ path: "/api/plex/plex-fixture/sections/7/refresh", method: "POST" },
		]);
		expect(scanBodies).toEqual([{ sectionUuid: "synthetic-section-primary" }]);
	});
	it("discovers configured sections from a genuinely cold query and writes only after selection", async () => {
		expect(client.getQueryData(plexKeys.sections())).toBeUndefined();
		mount();
		const button = await screen.findByRole("button", { name: "Scan Plex" });
		expect(calls.filter((c) => c.path === "/api/plex/sections")).toEqual([
			{ path: "/api/plex/sections", method: "GET" },
		]);
		expect(writes()).toEqual([]);
		fireEvent.click(button);
		await screen.findByRole("button", { name: /Synthetic film library/ });
		expect(writes()).toEqual([]);
		fireEvent.click(screen.getByRole("button", { name: /Synthetic film library/ }));
		await screen.findByText(/scan requested/i);
		expect(writes()).toEqual([
			{ path: "/api/plex/plex-fixture/sections/7/refresh", method: "POST" },
		]);
		expect(screen.queryByText(/scan completed/i)).not.toBeInTheDocument();
	});
	it.each(["absent", "disabled"] as const)(
		"makes no sections request for %s Plex",
		async (state) => {
			plex = state;
			mount();
			await settle();
			expect(calls.some((c) => c.path === "/api/plex/sections")).toBe(false);
			expect(screen.queryByRole("button", { name: "Scan Plex" })).not.toBeInTheDocument();
			expect(writes()).toEqual([]);
		},
	);
	it("does not expose cached sections after Plex is disabled", async () => {
		plex = "disabled";
		client.setQueryData(plexKeys.sections(), current);
		mount();
		await settle();
		expect(screen.queryByRole("button", { name: "Scan Plex" })).not.toBeInTheDocument();
		expect(calls.some((c) => c.path === "/api/plex/sections")).toBe(false);
		expect(writes()).toEqual([]);
	});
	it("does not invent scan targets for a successful empty sections result", async () => {
		sections = { ...current, sections: [] };
		mount();
		await settle();
		await waitFor(() => expect(client.getQueryState(plexKeys.sections())?.status).toBe("success"));
		expect(screen.queryByRole("button", { name: "Scan Plex" })).not.toBeInTheDocument();
		expect(screen.queryByRole("button", { name: /retry plex sections/i })).not.toBeInTheDocument();
		expect(writes()).toEqual([]);
	});
	it("masks the newly reachable section menu in incognito mode without changing its selected target", async () => {
		localStorage.setItem("arr-dashboard-incognito-mode", "true");
		mount();
		fireEvent.click(await screen.findByRole("button", { name: "Scan Plex" }));
		expect(screen.queryByText("Synthetic film library")).not.toBeInTheDocument();
		fireEvent.click(screen.getByRole("button", { name: /movie$/ }));
		await screen.findByText(/scan requested/i);
		expect(writes()).toEqual([
			{ path: "/api/plex/plex-fixture/sections/7/refresh", method: "POST" },
		]);
	});
	it("offers a read-only recovery for cold unavailable sections", async () => {
		sectionStatus = 503;
		mount();
		const retry = await screen.findByRole("button", { name: /retry plex sections/i });
		expect(screen.queryByRole("button", { name: "Scan Plex" })).not.toBeInTheDocument();
		expect(writes()).toEqual([]);
		sectionStatus = 200;
		fireEvent.click(retry);
		expect(await screen.findByRole("button", { name: "Scan Plex" })).toBeEnabled();
		expect(writes()).toEqual([]);
	});
	it("disables a retained section action after a failed refresh until GET recovery", async () => {
		mount();
		await screen.findByRole("button", { name: "Scan Plex" });
		fireEvent.click(screen.getByRole("button", { name: "Scan Plex" }));
		await screen.findByRole("button", { name: /Synthetic film library/ });
		sectionStatus = 503;
		await act(async () => {
			await client.refetchQueries({ queryKey: plexKeys.sections() });
		});
		await waitFor(() => expect(screen.getByRole("button", { name: "Scan Plex" })).toBeDisabled());
		fireEvent.click(screen.getByRole("button", { name: "Scan Plex" }));
		expect(
			screen.queryByRole("button", { name: /Synthetic film library/ }),
		).not.toBeInTheDocument();
		expect(writes()).toEqual([]);
		sectionStatus = 200;
		fireEvent.click(screen.getByRole("button", { name: /retry plex sections/i }));
		await waitFor(() => expect(screen.getByRole("button", { name: "Scan Plex" })).toBeEnabled());
		expect(writes()).toEqual([]);
	});
	it.each([
		undefined,
		null,
		{ availability: "unavailable", observedAt: null },
		{ availability: "unknown", observedAt: current.catalog.observedAt },
		{ availability: "current", observedAt: null },
		{ availability: "current", observedAt: "not-a-timestamp" },
		{ availability: "current", observedAt: 7 },
		{ availability: "last-known", observedAt: null },
		{ availability: "last-known", observedAt: "not-a-timestamp" },
	])("disables unknown or malformed catalog eligibility: %j", async (catalog) => {
		sections = { ...current, catalog } as PlexSectionsResponse;
		mount();
		await settle();
		await waitFor(() => expect(client.getQueryState(plexKeys.sections())?.status).toBe("success"));
		expect(screen.getByRole("button", { name: "Scan Plex" })).toBeDisabled();
		expect(screen.getByRole("button", { name: /retry plex sections/i })).toBeEnabled();
		expect(writes()).toEqual([]);
	});
	it("disables retained options during a section GET and enables them after read recovery", async () => {
		mount();
		const button = await screen.findByRole("button", { name: "Scan Plex" });
		fireEvent.click(button);
		await screen.findByRole("button", { name: /Synthetic film library/ });
		sectionWait = new Promise<void>((resolve) => {
			releaseSections = resolve;
		});
		let refetch: Promise<void>;
		act(() => {
			refetch = client.refetchQueries({ queryKey: plexKeys.sections() });
		});
		await waitFor(() => expect(button).toBeDisabled());
		expect(
			screen.queryByRole("button", { name: /Synthetic film library/ }),
		).not.toBeInTheDocument();
		expect(writes()).toEqual([]);
		await act(async () => {
			releaseSections!();
			await refetch;
		});
		await waitFor(() => expect(button).toBeEnabled());
		expect(writes()).toEqual([]);
	});
	it.each([undefined, "", "   ", 7])(
		"disables the catalog if any option has invalid UUID %j",
		async (sectionUuid) => {
			sections = {
				...current,
				sections: [section, { ...section, sectionId: "9", sectionUuid }],
			} as PlexSectionsResponse;
			mount();
			await settle();
			await waitFor(() =>
				expect(client.getQueryState(plexKeys.sections())?.status).toBe("success"),
			);
			expect(screen.getByRole("button", { name: "Scan Plex" })).toBeDisabled();
			expect(writes()).toEqual([]);
		},
	);
	it.each([
		undefined,
		{
			...current.evidence!,
			publicationLevel: "positive-only" as const,
			completeness: "partial" as const,
		},
	])(
		"offers a verified current catalog independently of canonical mapping/watch evidence",
		async (evidence) => {
			sections = { ...current, evidence };
			mount();
			await settle();
			await waitFor(() =>
				expect(client.getQueryState(plexKeys.sections())?.status).toBe("success"),
			);
			expect(screen.getByRole("button", { name: "Scan Plex" })).toBeEnabled();
			expect(writes()).toEqual([]);
		},
	);
	it("labels a last-known catalog and submits its UUID for server revalidation", async () => {
		sections = {
			...current,
			catalog: { ...current.catalog, availability: "last-known" },
			evidence: {
				...current.evidence!,
				publicationLevel: "unavailable",
				availability: "last-known",
			},
		};
		mount();
		const button = await screen.findByRole("button", { name: "Scan Plex" });
		expect(button).toBeEnabled();
		expect(screen.getByText(/last-known Plex section catalog/i)).toHaveTextContent(
			/server rechecks.*before.*scan/i,
		);
		fireEvent.click(button);
		fireEvent.click(await screen.findByRole("button", { name: /Synthetic film library/ }));
		await screen.findByText(/scan requested/i);
		expect(scanBodies).toEqual([{ sectionUuid: "synthetic-section-primary" }]);
	});
	it.each([200, 503])(
		"recovers a rejected UUID selection using GET only when recovery returns HTTP %s",
		async (recoveryStatus) => {
			mount();
			fireEvent.click(await screen.findByRole("button", { name: "Scan Plex" }));
			await screen.findByRole("button", { name: /Synthetic film library/ });
			scanStatus = 409;
			sectionStatus = recoveryStatus;
			sections = {
				...current,
				sections: [{ ...section, sectionUuid: "synthetic-section-replacement" }],
			};
			sectionWait = new Promise<void>((resolve) => {
				releaseSections = resolve;
			});
			fireEvent.click(screen.getByRole("button", { name: /Synthetic film library/ }));
			await waitFor(() =>
				expect(calls.filter((call) => call.path === "/api/plex/sections")).toHaveLength(2),
			);
			expect(
				calls.filter((call) => call.path === "/api/plex/sections" || call.method === "POST"),
			).toEqual([
				{ path: "/api/plex/sections", method: "GET" },
				{ path: "/api/plex/plex-fixture/sections/7/refresh", method: "POST" },
				{ path: "/api/plex/sections", method: "GET" },
			]);
			expect(screen.getByRole("button", { name: "Scan Plex" })).toBeDisabled();
			expect(
				screen.queryByRole("button", { name: /Synthetic film library/ }),
			).not.toBeInTheDocument();
			expect(scanBodies).toEqual([{ sectionUuid: "synthetic-section-primary" }]);
			await act(async () => {
				releaseSections!();
				await sectionWait;
			});
			expect(await screen.findByRole("alert")).toHaveTextContent(/no scan was requested/i);
			expect(
				screen.queryByText(/may have received|scan request not confirmed/i),
			).not.toBeInTheDocument();
			await waitFor(() =>
				expect(client.getQueryState(plexKeys.sections())?.status).toBe(
					recoveryStatus === 200 ? "success" : "error",
				),
			);
			expect(writes()).toHaveLength(1);
			if (recoveryStatus !== 200) {
				expect(screen.getByRole("button", { name: "Scan Plex" })).toBeDisabled();
				fireEvent.click(screen.getByRole("button", { name: "Scan Plex" }));
				expect(
					screen.queryByRole("button", { name: /Synthetic film library/ }),
				).not.toBeInTheDocument();
				expect(writes()).toHaveLength(1);
				expect(screen.getByRole("button", { name: /retry plex sections/i })).toBeEnabled();
				sectionStatus = 200;
				fireEvent.click(screen.getByRole("button", { name: /retry plex sections/i }));
			}
			await waitFor(() => expect(screen.getByRole("button", { name: "Scan Plex" })).toBeEnabled());
			expect(scanBodies).toEqual([{ sectionUuid: "synthetic-section-primary" }]);
			expect(calls.filter((call) => call.path === "/api/plex/sections")).toHaveLength(
				recoveryStatus === 200 ? 2 : 3,
			);
			scanStatus = 200;
			fireEvent.click(screen.getByRole("button", { name: "Scan Plex" }));
			expect(writes()).toHaveLength(1);
			fireEvent.click(await screen.findByRole("button", { name: /Synthetic film library/ }));
			await screen.findByText(/scan requested/i);
			expect(scanBodies).toEqual([
				{ sectionUuid: "synthetic-section-primary" },
				{ sectionUuid: "synthetic-section-replacement" },
			]);
			expect(writes()).toHaveLength(2);
		},
	);
	it.each([502, 503, "network"] as const)(
		"surfaces an unconfirmed %s scan request without automatic replay",
		async (failure) => {
			if (failure === "network") {
				scanResponse = () => {
					throw new TypeError("Synthetic connection lost");
				};
			} else {
				scanStatus = failure;
			}
			mount();
			fireEvent.click(await screen.findByRole("button", { name: "Scan Plex" }));
			fireEvent.click(await screen.findByRole("button", { name: /Synthetic film library/ }));
			expect(await screen.findByRole("alert")).toHaveTextContent(/not confirmed/i);
			expect(writes()).toHaveLength(1);
			expect(calls.filter((call) => call.path === "/api/plex/sections")).toHaveLength(1);
			expect(screen.queryByText(/scan requested/i)).not.toBeInTheDocument();
			scanStatus = 200;
			scanResponse = undefined;
			fireEvent.click(screen.getByRole("button", { name: "Scan Plex" }));
			fireEvent.click(await screen.findByRole("button", { name: /Synthetic film library/ }));
			await screen.findByText(/scan requested/i);
			expect(writes()).toHaveLength(2);
			expect(screen.queryByRole("alert")).not.toBeInTheDocument();
		},
	);
	it("keeps a pending request distinct from completion and prevents a second selection", async () => {
		scanWait = new Promise<void>((resolve) => {
			releaseScan = resolve;
		});
		mount();
		fireEvent.click(await screen.findByRole("button", { name: "Scan Plex" }));
		fireEvent.click(await screen.findByRole("button", { name: /Synthetic film library/ }));
		const pending = await screen.findByRole("button", { name: /requesting scan/i });
		expect(pending).toBeDisabled();
		fireEvent.click(pending);
		expect(
			screen.queryByRole("button", { name: /Synthetic film library/ }),
		).not.toBeInTheDocument();
		expect(screen.queryByText(/scan requested/i)).not.toBeInTheDocument();
		expect(writes()).toHaveLength(1);
		await act(async () => {
			releaseScan!();
			await scanWait;
		});
		await screen.findByText(/scan requested/i);
		expect(writes()).toHaveLength(1);
	});
});
