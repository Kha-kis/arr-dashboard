import { QueryClient, QueryClientProvider } from "@tanstack/react-query";
import { act, cleanup, fireEvent, render, screen, waitFor, within } from "@testing-library/react";
import type { ReactNode } from "react";
import { Toaster, toast } from "sonner";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { IncognitoProvider } from "../../../../contexts/IncognitoContext";
import { ColorThemeProvider } from "../../../../providers/color-theme-provider";

type Event = { url: string; method: string; body: Record<string, unknown> | null };
let client: QueryClient;
const events: Event[] = [],
	unexpected: string[] = [],
	pending = new Set<Promise<Response>>();
const gates: Array<{
	promise: Promise<Response>;
	release: (response: Response) => void;
	closed: boolean;
}> = [];
function response(body: unknown, status = 200) {
	return new Response(JSON.stringify(body), {
		status,
		headers: { "Content-Type": "application/json" },
	});
}
function gate() {
	let resolve!: (response: Response) => void;
	const value = {
		promise: new Promise<Response>((done) => {
			resolve = done;
		}),
		release: (result: Response) => {
			value.closed = true;
			resolve(result);
		},
		closed: false,
	};
	gates.push(value);
	return value;
}
function transport(handler: (event: Event) => Response | Promise<Response> | undefined) {
	vi.stubGlobal(
		"fetch",
		vi.fn((input: string | URL | Request, init?: RequestInit) => {
			const event = {
				url: String(input),
				method: init?.method ?? "GET",
				body: init?.body ? JSON.parse(String(init.body)) : null,
			};
			events.push(event);
			const task = Promise.resolve().then(() => {
				const result = handler(event);
				if (!result) {
					unexpected.push(JSON.stringify(event));
					throw Error("Unexpected synthetic fetch " + event.url);
				}
				return result;
			});
			pending.add(task);
			void task.then(
				() => pending.delete(task),
				() => pending.delete(task),
			);
			return task;
		}),
	);
}
function mount(children: ReactNode) {
	client = new QueryClient({
		defaultOptions: { queries: { retry: false, gcTime: Infinity }, mutations: { retry: false } },
	});
	render(
		<QueryClientProvider client={client}>
			<ColorThemeProvider>
				<IncognitoProvider>
					{children}
					<Toaster />
				</IncognitoProvider>
			</ColorThemeProvider>
		</QueryClientProvider>,
	);
}
const service = {
	id: "radarr-a",
	service: "radarr",
	label: "Synthetic Radarr",
	baseUrl: "http://synthetic.invalid",
	externalUrl: null,
	enabled: true,
	isDefault: true,
	hasApiKey: true,
	hasHttpAuth: false,
	storageGroupId: null,
	hasLocalFilesystemAccess: false,
	pathPrefix: null,
	identity: {
		status: "unverified",
		kind: null,
		fingerprint: null,
		verifiedAt: null,
		lastCheckedAt: null,
	},
	createdAt: "2026-01-01T00:00:00Z",
	updatedAt: "2026-01-01T00:00:00Z",
	tags: [],
};
beforeEach(() => {
	events.length = 0;
	unexpected.length = 0;
	gates.length = 0;
	localStorage.clear();
	vi.stubGlobal(
		"matchMedia",
		vi.fn(() => ({
			matches: false,
			media: "",
			onchange: null,
			addListener() {},
			removeListener() {},
			addEventListener() {},
			removeEventListener() {},
			dispatchEvent() {
				return false;
			},
		})),
	);
});
afterEach(async () => {
	await act(async () => {
		for (const held of gates)
			if (!held.closed) held.release(response({ message: "Synthetic teardown refusal" }, 503));
		await Promise.allSettled([...pending]);
	});
	cleanup();
	await client?.cancelQueries();
	client?.clear();
	toast.dismiss();
	expect(pending.size).toBe(0);
	expect(gates.every((value) => value.closed)).toBe(true);
	expect(unexpected).toEqual([]);
	vi.restoreAllMocks();
	vi.unstubAllGlobals();
});

import type { TrashTemplate } from "@arr/shared";
import { useState } from "react";
import { useTrashCacheStatus } from "../../../../hooks/api/useTrashCache";
import { useTrashGuidesActions } from "../../hooks/use-trash-guides-actions";
import { CacheStatusSection } from "../cache-status-section";
import { TemplateEditor } from "../template-editor";
import { TemplateList } from "../template-list";
import { TemplateUpdateBanner } from "../template-update-banner";

const original = {
	id: "template-a",
	userId: "owner",
	name: "Selected template",
	description: "",
	serviceType: "RADARR",
	config: { customFormats: [], customFormatGroups: [], syncSettings: { deleteRemovedCFs: false } },
	createdAt: "2026-01-01T00:00:00Z",
	updatedAt: "2026-01-01T00:00:00Z",
	usageCount: 0,
	isDefault: false,
	isActive: false,
	instanceIds: [],
} as unknown as TrashTemplate;
function OrdinaryList() {
	const [editing, setEditing] = useState<TrashTemplate | undefined>();
	return (
		<>
			<TemplateList
				onCreateNew={() => {}}
				onEdit={setEditing}
				onImport={() => {}}
				onBrowseQualityProfiles={() => {}}
			/>
			<TemplateEditor open={!!editing} template={editing} onClose={() => setEditing(undefined)} />
		</>
	);
}
function CacheControl() {
	// Disclosed prop-only glue: real production hooks/actions bind the real
	// maintained CacheStatusSection, without inventing delete/entry controls.
	const { data } = useTrashCacheStatus("RADARR"),
		actions = useTrashGuidesActions();
	return (
		<CacheStatusSection
			serviceType="RADARR"
			statuses={data?.radarr ?? []}
			configTypeLabels={{ CUSTOM_FORMATS: "Custom Formats" }}
			refreshing={actions.refreshing === "RADARR"}
			onRefresh={() => {
				void actions.handleRefresh("RADARR");
			}}
			onDelete={actions.handleDelete}
			isRefreshPending={actions.refreshMutation.isPending}
		/>
	);
}
describe("ordinary templates and maintained update/cache controls", () => {
	it("W11 ordinary edit/duplicate/delete confirmation with failed draft and current list readback", async () => {
		let templates = [structuredClone(original)],
			duplicateAttempts = 0;
		const held = gate();
		transport((event) => {
			if (event.url === "/api/services") return response({ services: [] });
			if (event.url === "/api/trash-guides/updates")
				return response({ success: true, data: { templatesWithUpdates: [], totalTemplates: 1 } });
			if (event.url.startsWith("/api/trash-guides/templates?"))
				return response({ templates, count: templates.length });
			if (event.url.startsWith("/api/trash-guides/cache/entries?")) return response([]);
			if (event.url.endsWith("/stats"))
				return response({
					stats: {
						instances: [],
						formatCount: 0,
						groupCount: 0,
						usageCount: 0,
						isActive: false,
						activeInstanceCount: 0,
					},
				});
			if (event.url === "/api/trash-guides/templates/template-a" && event.method === "PUT") {
				templates[0] = { ...templates[0]!, ...event.body } as TrashTemplate;
				return response({ template: templates[0] });
			}
			if (event.url.endsWith("/template-a/duplicate")) {
				if (++duplicateAttempts === 1) return held.promise;
				const copy = { ...templates[0]!, id: "template-copy", name: String(event.body!.newName) };
				templates.push(copy);
				return response({ template: copy }, 201);
			}
			if (event.url.endsWith("/templates/template-copy") && event.method === "DELETE") {
				templates = templates.filter((template) => template.id !== "template-copy");
				return response({ message: "Deleted", templateId: "template-copy" });
			}
		});
		mount(<OrdinaryList />);
		fireEvent.click(await screen.findByRole("button", { name: "Edit template Selected template" }));
		fireEvent.change(await screen.findByPlaceholderText("My Custom Template"), {
			target: { value: "Renamed template" },
		});
		fireEvent.click(screen.getByRole("button", { name: "Update Template" }));
		await screen.findByRole("button", { name: "Edit template Renamed template" });
		fireEvent.click(screen.getByRole("button", { name: "Duplicate template Renamed template" }));
		fireEvent.change(screen.getByPlaceholderText("New template name"), {
			target: { value: "Selected copy" },
		});
		fireEvent.click(screen.getByRole("button", { name: "Create" }));
		await waitFor(() => expect(duplicateAttempts).toBe(1));
		await act(async () => held.release(response({ message: "Duplicate refused" }, 503)));
		await screen.findByText("Duplicate refused");
		expect(screen.getByPlaceholderText("New template name")).toHaveValue("Selected copy");
		fireEvent.click(screen.getByRole("button", { name: "Create" }));
		await screen.findByRole("button", { name: "Delete template Selected copy" });
		fireEvent.click(screen.getByRole("button", { name: "Delete template Selected copy" }));
		fireEvent.click(screen.getByRole("button", { name: "Cancel" }));
		expect(events.filter((event) => event.method === "DELETE")).toHaveLength(0);
		fireEvent.click(screen.getByRole("button", { name: "Delete template Selected copy" }));
		fireEvent.click(screen.getByRole("button", { name: "Delete" }));
		await waitFor(() =>
			expect(
				screen.queryByRole("button", { name: "Delete template Selected copy" }),
			).not.toBeInTheDocument(),
		);
		expect(
			events.filter((event) => event.url.endsWith("/duplicate")).map((event) => event.body),
		).toEqual([{ newName: "Selected copy" }, { newName: "Selected copy" }]);
		expect(events.filter((event) => event.method === "DELETE")).toEqual([
			{ url: "/api/trash-guides/templates/template-copy", method: "DELETE", body: null },
		]);
	});
	it("W12 selected template update/manual-sync cancel and held refusal recovery; maintained cache refresh/current status", async () => {
		const held = gate();
		let syncs = 0,
			refreshes = 0,
			version = 1;
		transport((event) => {
			if (event.url === "/api/trash-guides/updates/template-a/diff")
				return response({
					success: true,
					data: {
						templateId: "template-a",
						templateName: "Selected template",
						currentCommit: "old",
						latestCommit: "new",
						hasUserModifications: false,
						customFormatDiffs: [],
						summary: {
							totalChanges: 1,
							addedCFs: 0,
							removedCFs: 0,
							modifiedCFs: 1,
							unchangedCFs: 0,
						},
						suggestedAdditions: [],
						suggestedScoreChanges: [],
					},
				});
			if (event.url === "/api/trash-guides/updates/template-a/sync")
				return ++syncs === 1
					? held.promise
					: response({
							success: true,
							data: {
								templateId: "template-a",
								previousCommit: "old",
								newCommit: "new",
								message: "Synced",
							},
						});
			if (event.url === "/api/trash-guides/cache/status?serviceType=RADARR")
				return response({
					radarr: [
						{
							serviceType: "RADARR",
							configType: "CUSTOM_FORMATS",
							version,
							itemCount: 2,
							lastFetched: "2026-01-01T00:00:00Z",
							isStale: false,
						},
					],
					sonarr: [],
				});
			if (event.url === "/api/trash-guides/cache/refresh") {
				refreshes++;
				if (refreshes === 1) return response({ message: "Cache refused" }, 503);
				version = 2;
				return response({
					message: "Refreshed",
					refreshed: true,
					results: { CUSTOM_FORMATS: { success: true } },
				});
			}
		});
		mount(
			<>
				<TemplateUpdateBanner
					update={{
						templateId: "template-a",
						templateName: "Selected template",
						serviceType: "RADARR",
						currentCommit: "old",
						latestCommit: "new",
						hasUserModifications: false,
						canAutoSync: false,
						autoSyncInstanceCount: 0,
					}}
				/>
				<CacheControl />
			</>,
		);
		fireEvent.click(screen.getByRole("button", { name: "View Changes" }));
		const dialog = await screen.findByRole("dialog");
		await within(dialog).findByRole("button", { name: /Sync with smart merge/ });
		fireEvent.click(within(dialog).getByRole("button", { name: "Cancel" }));
		expect(syncs).toBe(0);
		fireEvent.click(screen.getByRole("button", { name: "View Changes" }));
		fireEvent.click(await screen.findByRole("button", { name: /Sync with smart merge/ }));
		await screen.findByRole("button", { name: "Syncing..." });
		await act(async () => held.release(response({ message: "Template sync refused" }, 503)));
		await screen.findByText("Template sync refused");
		fireEvent.click(screen.getByRole("button", { name: /Sync with smart merge/ }));
		await screen.findByText("Template synced successfully");
		expect(
			events.filter((event) => event.url.endsWith("/template-a/sync")).map((event) => event.body),
		).toEqual([{ strategy: "merge" }, { strategy: "merge" }]);
		fireEvent.click(screen.getByRole("button", { name: "Refresh All" }));
		await screen.findByText("Failed to refresh radarr cache: Cache refused");
		await screen.findByText("Version 1");
		fireEvent.click(screen.getByRole("button", { name: "Refresh All" }));
		await screen.findByText("Version 2");
		expect(
			events.filter((event) => event.url.endsWith("/cache/refresh")).map((event) => event.body),
		).toEqual([
			{ serviceType: "RADARR", force: true },
			{ serviceType: "RADARR", force: true },
		]);
		// CacheStatusSection currently discards onDelete/onRefreshEntry props:
		// no maintained per-entry cache-delete button exists to click.
		expect(
			screen.queryByRole("button", { name: /delete.*cache|remove.*cache/i }),
		).not.toBeInTheDocument();
	});
});
