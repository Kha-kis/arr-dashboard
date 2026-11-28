import { QueryClient, QueryClientProvider } from "@tanstack/react-query";
import { act, cleanup, fireEvent, render, screen, waitFor, within } from "@testing-library/react";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { IncognitoProvider } from "../../../../contexts/IncognitoContext";
import type { SyncHistoryItem } from "../../../../lib/api-client/trash-guides/sync";
import { syncKeys } from "../../../../lib/query-keys";
import { ColorThemeProvider } from "../../../../providers/color-theme-provider";
import { TrashGuidesClient } from "../trash-guides-client";

// Keep the real History tab, panel, query hooks and HTTP client. Unrelated tabs
// and deployment history have their own tests and do not participate here.
vi.mock("../../hooks/use-trash-guides-data", () => ({
	useTrashGuidesData: () => ({ cacheStatus: { radarr: [], sonarr: [] }, refetchCache: vi.fn() }),
}));
vi.mock("../../hooks/use-trash-guides-actions", () => ({
	useTrashGuidesActions: () => ({ refreshMutation: {}, deleteMutation: {} }),
}));
vi.mock("../../hooks/use-trash-guides-modals", () => ({ useTrashGuidesModals: () => ({}) }));
vi.mock("../../../../hooks/api/useAuth", () => ({
	useCurrentUser: () => ({ data: { id: "owner" } }),
}));
vi.mock("../bulk-score-manager", () => ({ BulkScoreManager: () => null }));
vi.mock("../cache-status-section", () => ({ CacheStatusSection: () => null }));
vi.mock("../custom-formats-browser", () => ({ CustomFormatsBrowser: () => null }));
vi.mock("../deployment-history-table", () => ({ DeploymentHistoryTable: () => null }));
vi.mock("../quality-profile-wizard", () => ({ QualityProfileWizard: () => null }));
vi.mock("../quality-size-manager", () => ({ QualitySizeManager: () => null }));
vi.mock("../repo-settings-section", () => ({ RepoSettingsSection: () => null }));
vi.mock("../scheduler-status-dashboard", () => ({ SchedulerStatusDashboard: () => null }));
vi.mock("../template-editor", () => ({ TemplateEditor: () => null }));
vi.mock("../template-import-dialog", () => ({ TemplateImportDialog: () => null }));
vi.mock("../template-list", () => ({ TemplateList: () => null }));

type Request = { url: string; method: string; body: unknown };
const requests: Request[] = [];
let client: QueryClient;
let history: (instanceId: string, offset: number) => Response | Promise<Response>;
let acknowledge: () => Response | Promise<Response>;
let services: () => Response | Promise<Response>;
const deferredResponses: Array<() => void> = [];
const unexpected: Request[] = [];

function deferred() {
	let resolve!: (response: Response) => void;
	const promise = new Promise<Response>((done) => {
		resolve = done;
	});
	deferredResponses.push(() => resolve(response({ syncs: [], total: 0 })));
	return { promise, resolve };
}

function response(body: unknown, status = 200) {
	return new Response(JSON.stringify(body), {
		status,
		headers: { "Content-Type": "application/json" },
	});
}

function sync(overrides: Partial<SyncHistoryItem> = {}): SyncHistoryItem {
	return {
		id: "sync-a",
		templateId: "template-a",
		templateName: "Private template name",
		status: "UNCERTAIN",
		syncType: "MANUAL",
		startedAt: "2026-11-21T12:00:00.000Z",
		completedAt: null,
		duration: null,
		configsApplied: 0,
		configsFailed: 0,
		configsSkipped: 0,
		backupId: null,
		...overrides,
	};
}

function posts() {
	return requests.filter((request) => request.method === "POST");
}

function mount() {
	client = new QueryClient({
		defaultOptions: {
			queries: { retry: false, retryDelay: 0, gcTime: Infinity },
			mutations: { retry: false },
		},
	});
	render(
		<QueryClientProvider client={client}>
			<ColorThemeProvider>
				<IncognitoProvider>
					<TrashGuidesClient />
				</IncognitoProvider>
			</ColorThemeProvider>
		</QueryClientProvider>,
	);
	fireEvent.click(screen.getByRole("button", { name: "History" }));
}

async function selectInstance(id = "sonarr-a") {
	const select = await screen.findByRole("combobox", { name: "Sync review instance" });
	await waitFor(() => expect(select).toBeEnabled());
	fireEvent.change(select, { target: { value: id } });
}

beforeEach(() => {
	requests.length = 0;
	unexpected.length = 0;
	deferredResponses.length = 0;
	localStorage.clear();
	history = () => response({ syncs: [sync()], total: 1 });
	acknowledge = () =>
		response({ success: true, status: "FAILED", message: "Server acknowledgment" });
	services = () =>
		response({
			services: [
				{ id: "sonarr-a", service: "sonarr", label: "Private Sonarr A" },
				{ id: "radarr-b", service: "radarr", label: "Private Radarr B" },
				{ id: "other", service: "prowlarr", label: "Excluded service" },
			],
		});
	vi.stubGlobal(
		"fetch",
		vi.fn(async (input: string | URL, init?: RequestInit) => {
			const request = {
				url: String(input),
				method: init?.method ?? "GET",
				body: init?.body ? JSON.parse(String(init.body)) : null,
			};
			requests.push(request);
			if (request.url === "/api/services") return services();
			const match = request.url.match(
				/^\/api\/trash-guides\/sync\/history\/([^?]+)\?limit=20&offset=(\d+)$/,
			);
			if (match) return history(match[1]!, Number(match[2]));
			if (request.url.endsWith("/acknowledge-review") && request.method === "POST")
				return acknowledge();
			unexpected.push(request);
			throw new Error("Unexpected synthetic request");
		}),
	);
});

afterEach(() => {
	cleanup();
	client?.clear();
	for (const release of deferredResponses) release();
	vi.unstubAllGlobals();
	vi.restoreAllMocks();
	expect(unexpected).toEqual([]);
});

async function openReview() {
	fireEvent.click(await screen.findByRole("button", { name: "Review current ARR state" }));
	return screen.getByRole("dialog", { name: "Record manual review" });
}

function confirmReview() {
	const dialog = screen.getByRole("dialog", { name: "Record manual review" });
	fireEvent.click(
		within(dialog).getByRole("checkbox", {
			name: "I reviewed the current ARR state and accept it.",
		}),
	);
	fireEvent.click(within(dialog).getByRole("button", { name: "Record manual review" }));
}

describe("Sync review access through global TRaSH History", () => {
	it("exposes the existing manual-review capability on the History tab", async () => {
		mount();
		expect(screen.getByRole("region", { name: "Sync history and review" })).toBeInTheDocument();
		await selectInstance();
		expect(await screen.findByRole("button", { name: "Review current ARR state" })).toBeEnabled();
		expect(posts()).toEqual([]);
	});

	it("queries only an explicitly selected ARR instance and never posts on selection, refresh or cancel", async () => {
		mount();
		await waitFor(() => expect(screen.getByRole("combobox")).toBeEnabled());
		expect(requests.filter((request) => request.url.includes("/sync/history/"))).toEqual([]);
		expect(screen.queryByRole("option", { name: "Excluded service" })).toBeNull();
		await selectInstance();
		await openReview();
		expect(screen.getByRole("button", { name: "Record manual review" })).toBeDisabled();
		fireEvent.click(screen.getByRole("button", { name: "Cancel" }));
		expect(screen.queryByRole("dialog")).toBeNull();
		fireEvent.click(screen.getByRole("button", { name: "Refresh sync history" }));
		await waitFor(() =>
			expect(requests.filter((request) => request.url.includes("/history/sonarr-a")).length).toBe(
				2,
			),
		);
		await selectInstance("radarr-b");
		await screen.findByRole("button", { name: "Review current ARR state" });
		expect(requests.some((request) => request.url.includes("/history/radarr-b"))).toBe(true);
		expect(posts()).toEqual([]);
	});

	it("requires explicit checkbox confirmation of the exact target, blocks duplicates, and invalidates after acknowledgment", async () => {
		const pending = deferred();
		acknowledge = () => pending.promise;
		mount();
		await selectInstance("radarr-b");
		const dialog = await openReview();
		expect(
			within(dialog).getByText(/Private template name on Private Radarr B/),
		).toBeInTheDocument();
		const confirm = within(dialog).getByRole("button", { name: "Record manual review" });
		fireEvent.click(confirm);
		expect(posts()).toEqual([]);
		confirmReview();
		await waitFor(() =>
			expect(posts()).toEqual([
				{ url: "/api/trash-guides/sync/sync-a/acknowledge-review", method: "POST", body: {} },
			]),
		);
		expect(client.getMutationCache().getAll()[0]?.state.variables).toEqual({
			syncId: "sync-a",
			instanceId: "radarr-b",
		});
		expect(screen.getByRole("button", { name: "Recording review…" })).toBeDisabled();
		expect(screen.getByRole("button", { name: "Cancel" })).toBeDisabled();
		expect(screen.getByRole("combobox", { hidden: true })).toBeDisabled();
		fireEvent.click(confirm);
		expect(posts()).toHaveLength(1);
		history = () => response({ syncs: [sync({ status: "FAILED" })], total: 1 });
		await act(async () =>
			pending.resolve(
				response({ success: true, status: "FAILED", message: "Private server text" }),
			),
		);
		expect(
			await screen.findByText(
				"Manual review recorded. No rollback was performed. Other operations may still need review.",
			),
		).toBeInTheDocument();
		await waitFor(() => expect(screen.queryByRole("dialog")).toBeNull());
		expect(await screen.findByText("No uncertain syncs on this page.")).toBeInTheDocument();
		expect(requests.filter((request) => request.url.includes("/history/radarr-b"))).toHaveLength(2);
		expect(screen.queryByText("Private server text")).toBeNull();
		expect(posts()).toHaveLength(1);
	});

	it("offers no manual acceptance for ledger-backed, missing-linkage or non-uncertain syncs", async () => {
		const missing = sync({ id: "missing" });
		Reflect.deleteProperty(missing, "backupId");
		history = () =>
			response({
				syncs: [
					sync({ id: "ledger", backupId: "backup" }),
					missing,
					sync({ id: "done", status: "SUCCESS" }),
				],
				total: 3,
			});
		mount();
		await selectInstance();
		expect(await screen.findByText(/This sync has a rollback ledger/)).toBeInTheDocument();
		expect(
			screen.getByText("Backup linkage is unavailable. Refresh history before manual review."),
		).toBeInTheDocument();
		expect(screen.queryByRole("button", { name: "Review current ARR state" })).toBeNull();
		expect(posts()).toEqual([]);
	});

	it("handles a stale-state 409 with generic failure and a fresh read, without claiming success", async () => {
		acknowledge = () => {
			history = () => response({ syncs: [sync({ backupId: "new-ledger" })], total: 1 });
			return response({ message: "Private upstream URL and secret title" }, 409);
		};
		mount();
		await selectInstance();
		await openReview();
		confirmReview();
		expect(await screen.findByRole("alert")).toHaveTextContent(
			"Manual review could not be recorded",
		);
		expect(await screen.findByText(/This sync has a rollback ledger/)).toBeInTheDocument();
		expect(screen.queryByRole("dialog")).toBeNull();
		expect(screen.queryByText(/Private upstream/)).toBeNull();
		expect(screen.queryByText(/Manual review recorded\./)).toBeNull();
		expect(posts()).toHaveLength(1);
		expect(requests.filter((request) => request.url.includes("/history/sonarr-a"))).toHaveLength(2);
	});

	it("permits an explicit fresh retry after network failure and never retries the POST automatically", async () => {
		acknowledge = () => {
			throw new Error("private connection URL");
		};
		mount();
		await selectInstance();
		await openReview();
		confirmReview();
		expect(await screen.findByRole("alert")).toHaveTextContent(
			"Manual review could not be recorded",
		);
		await waitFor(() => expect(screen.queryByRole("dialog")).toBeNull());
		expect(posts()).toHaveLength(1);
		const dialog = await openReview();
		expect(within(dialog).getByRole("checkbox")).not.toBeChecked();
		acknowledge = () => response({ success: true, status: "FAILED" });
		confirmReview();
		expect(await screen.findByText(/Manual review recorded\./)).toBeInTheDocument();
		expect(posts()).toHaveLength(2);
		expect(screen.queryByText(/private connection/)).toBeNull();
	});

	it("paginates over server total and can review an uncertain sync beyond the first 20", async () => {
		history = (_instanceId, offset) =>
			response({
				syncs:
					offset === 0
						? Array.from({ length: 20 }, (_, i) => sync({ id: `done-${i}`, status: "SUCCESS" }))
						: [sync({ id: "older-sync" })],
				total: 21,
			});
		mount();
		await selectInstance();
		expect(await screen.findByText("No uncertain syncs on this page.")).toBeInTheDocument();
		expect(screen.getByText("Page 1 · 21 total syncs")).toBeInTheDocument();
		expect(screen.getByRole("button", { name: "Previous sync page" })).toBeDisabled();
		fireEvent.click(screen.getByRole("button", { name: "Next sync page" }));
		await openReview();
		confirmReview();
		await waitFor(() =>
			expect(posts()[0]?.url).toBe("/api/trash-guides/sync/older-sync/acknowledge-review"),
		);
		await screen.findByText(/Manual review recorded\./);
		expect(screen.getByText("Page 2 · 21 total syncs")).toBeInTheDocument();
		expect(screen.getByRole("button", { name: "Next sync page" })).toBeDisabled();
		expect(requests.some((request) => request.url.endsWith("offset=20"))).toBe(true);
	});

	it("closes stale confirmation and resets consent when the instance or page changes", async () => {
		history = () => response({ syncs: [sync()], total: 21 });
		mount();
		await selectInstance();
		const select = screen.getByRole("combobox");
		const next = await screen.findByRole("button", { name: "Next sync page" });
		await openReview();
		fireEvent.click(screen.getByRole("checkbox"));
		fireEvent.click(next);
		await waitFor(() => expect(screen.queryByRole("dialog")).toBeNull());
		await openReview();
		expect(screen.getByRole("checkbox")).not.toBeChecked();
		fireEvent.click(screen.getByRole("checkbox"));
		fireEvent.change(select, { target: { value: "radarr-b" } });
		await waitFor(() => expect(screen.queryByRole("dialog")).toBeNull());
		await openReview();
		expect(screen.getByRole("checkbox")).not.toBeChecked();
		expect(screen.getByRole("dialog")).toHaveTextContent("Private Radarr B");
		expect(posts()).toEqual([]);
	});

	it("closes stale confirmation during refetch and refuses actions after a history read error", async () => {
		mount();
		await selectInstance();
		await openReview();
		fireEvent.click(screen.getByRole("checkbox"));
		history = () => response({ message: "private read failure" }, 503);
		await act(async () => {
			await client.invalidateQueries({
				queryKey: syncKeys.history("sonarr-a", { limit: 20, offset: 0 }),
			});
		});
		expect(await screen.findByRole("alert")).toHaveTextContent("Sync history is unavailable");
		expect(screen.queryByRole("dialog")).toBeNull();
		expect(screen.queryByRole("button", { name: "Review current ARR state" })).toBeNull();
		history = () => response({ syncs: [sync()], total: 1 });
		fireEvent.click(screen.getByRole("button", { name: "Refresh sync history" }));
		await openReview();
		expect(screen.getByRole("checkbox")).not.toBeChecked();
		expect(posts()).toEqual([]);
	});

	it("keeps a successful acknowledgment distinct from a failed readback and retries only the read", async () => {
		acknowledge = () => {
			history = () => response({ message: "private readback failure" }, 503);
			return response({ success: true, status: "FAILED" });
		};
		mount();
		await selectInstance();
		await openReview();
		confirmReview();
		expect(await screen.findByText(/Manual review recorded\./)).toBeInTheDocument();
		expect(await screen.findByRole("alert")).toHaveTextContent("Sync history is unavailable");
		expect(screen.queryByText(/Manual review could not be recorded/)).toBeNull();
		expect(screen.queryByRole("button", { name: "Review current ARR state" })).toBeNull();
		expect(posts()).toHaveLength(1);
		history = () => response({ syncs: [sync({ status: "FAILED" })], total: 1 });
		fireEvent.click(screen.getByRole("button", { name: "Refresh sync history" }));
		expect(await screen.findByText("No uncertain syncs on this page.")).toBeInTheDocument();
		expect(posts()).toHaveLength(1);
	});

	it("keeps late results for the previous instance out of the current selection", async () => {
		const old = deferred();
		history = (id) =>
			id === "sonarr-a"
				? old.promise
				: response({
						syncs: [sync({ id: "radarr-sync", templateName: "Radarr template" })],
						total: 1,
					});
		mount();
		await selectInstance();
		expect(await screen.findByText("Loading sync history…")).toBeInTheDocument();
		await selectInstance("radarr-b");
		expect(await screen.findByText("Radarr template")).toBeInTheDocument();
		await act(async () =>
			old.resolve(response({ syncs: [sync({ templateName: "Old selection" })], total: 1 })),
		);
		expect(screen.queryByText("Old selection")).toBeNull();
		await openReview();
		confirmReview();
		await waitFor(() =>
			expect(posts()[0]?.url).toBe("/api/trash-guides/sync/radarr-sync/acknowledge-review"),
		);
	});

	it("reports instance loading and unavailable states honestly without reading syncs", async () => {
		const pending = deferred();
		services = () => pending.promise;
		mount();
		expect(screen.getByText("Loading instances…")).toBeInTheDocument();
		expect(screen.getByRole("combobox")).toBeDisabled();
		services = () => response({ message: "private service error" }, 503);
		await act(async () => pending.resolve(response({ message: "private service error" }, 503)));
		expect(await screen.findByRole("alert")).toHaveTextContent("Instances are unavailable");
		expect(screen.queryByText("No Sonarr or Radarr instances are available.")).toBeNull();
		expect(requests.some((request) => request.url.includes("/sync/history/"))).toBe(false);
		expect(posts()).toEqual([]);
	});

	it("masks instance and template names in options, rows and confirmation and supports keyboard escape", async () => {
		localStorage.setItem("arr-dashboard-incognito-mode", "true");
		mount();
		await selectInstance();
		const dialog = await openReview();
		expect(document.body.textContent).not.toContain("Private Sonarr A");
		expect(document.body.textContent).not.toContain("Private Radarr B");
		expect(document.body.textContent).not.toContain("Private template name");
		expect(dialog).toHaveAccessibleName("Record manual review");
		expect(dialog).toHaveAccessibleDescription(/Review .* on Sonarr Main 1 in ARR/);
		const checkbox = within(dialog).getByRole("checkbox", {
			name: "I reviewed the current ARR state and accept it.",
		});
		await waitFor(() => expect(checkbox).toHaveFocus());
		fireEvent.keyDown(checkbox, { key: "Escape", code: "Escape" });
		await waitFor(() => expect(screen.queryByRole("dialog")).toBeNull());
		expect(screen.getByRole("button", { name: "Refresh sync history" })).toHaveFocus();
		expect(posts()).toEqual([]);
	});
});
