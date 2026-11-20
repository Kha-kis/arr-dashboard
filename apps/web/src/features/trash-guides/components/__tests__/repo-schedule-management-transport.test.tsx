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

import { RepoSettingsSection } from "../repo-settings-section";
import { TemplateStats } from "../template-stats";

describe("Repository and template schedule maintained transport", () => {
	it("W9 unsaved repo test/save refusal retains draft, explicit retry/current readback and reset", async () => {
		let attempts = 0,
			settings = {
				id: "settings-a",
				userId: "owner",
				checkFrequency: 24,
				autoRefreshCache: true,
				notifyOnUpdates: true,
				notifyOnSyncFail: true,
				backupRetention: 5,
				backupRetentionDays: 30,
				customRepoOwner: "saved",
				customRepoName: "Guides",
				customRepoBranch: "main",
				customRepoMode: "fork",
			};
		const held = gate();
		transport((event) => {
			if (event.url === "/api/trash-guides/settings" && event.method === "GET")
				return response({
					settings,
					defaultRepo: { owner: "TRaSH-Guides", name: "Guides", branch: "master" },
				});
			if (event.url.endsWith("/settings/test-repo"))
				return response({
					valid: true,
					repo: "draft/Guides",
					branch: "feature",
					structure: { hasRadarr: true, hasSonarr: true, directoriesFound: ["docs"] },
				});
			if (event.url === "/api/trash-guides/settings" && event.method === "PATCH") {
				attempts++;
				if (attempts === 1) return held.promise;
				settings = { ...settings, ...event.body };
				return response({ settings, cacheCleared: false, message: "Synthetic repository saved" });
			}
			if (event.url.endsWith("/settings/reset-repo")) {
				settings = {
					...settings,
					customRepoOwner: "",
					customRepoName: "",
					customRepoBranch: "master",
				};
				return response({ settings, message: "Reset", cacheEntriesCleared: 0 });
			}
		});
		mount(<RepoSettingsSection />);
		const url = await screen.findByPlaceholderText("https://github.com/owner/Guides");
		fireEvent.change(url, { target: { value: "https://github.com/draft/Guides" } });
		fireEvent.change(screen.getByPlaceholderText("main"), { target: { value: "feature" } });
		fireEvent.click(screen.getByRole("button", { name: "Test Connection" }));
		await waitFor(() =>
			expect(events.some((event) => event.url.endsWith("/test-repo"))).toBe(true),
		);
		expect(events.find((event) => event.url.endsWith("/test-repo"))!.body).toEqual({
			owner: "draft",
			name: "Guides",
			branch: "feature",
		});
		expect(settings.customRepoOwner).toBe("saved");
		fireEvent.click(screen.getByRole("button", { name: "Save & Refresh Cache" }));
		await waitFor(() => expect(attempts).toBe(1));
		await act(async () => held.release(response({ message: "Repository save refused" }, 503)));
		await screen.findByText(/Repository save refused/);
		expect(url).toHaveValue("https://github.com/draft/Guides");
		expect(screen.getByPlaceholderText("main")).toHaveValue("feature");
		fireEvent.click(screen.getByRole("button", { name: "Save & Refresh Cache" }));
		await waitFor(() => expect(settings.customRepoOwner).toBe("draft"));
		await waitFor(() =>
			expect(events.filter((event) => event.method === "GET").length).toBeGreaterThan(1),
		);
		expect(events.filter((event) => event.method === "PATCH").map((event) => event.body)).toEqual([
			{
				customRepoOwner: "draft",
				customRepoName: "Guides",
				customRepoBranch: "feature",
				customRepoMode: "fork",
			},
			{
				customRepoOwner: "draft",
				customRepoName: "Guides",
				customRepoBranch: "feature",
				customRepoMode: "fork",
			},
		]);
		// No confirmation control exists in RepoSettingsSection: handleReset is
		// directly bound. Drain the real hook's 15/45/75s invalidation timers.
		vi.useFakeTimers();
		await act(async () => {
			fireEvent.click(screen.getByRole("button", { name: "Reset to Official" }));
			await Promise.resolve();
		});
		await act(async () => {
			await vi.advanceTimersByTimeAsync(75001);
		});
		vi.useRealTimers();
		await waitFor(() => expect(url).toHaveValue(""));
		expect(screen.queryByRole("button", { name: "Reset to Official" })).not.toBeInTheDocument();
		expect(events.filter((event) => event.url.endsWith("/reset-repo"))).toHaveLength(1);
	});
	it("W10 actual Stats opens schedule, preserves failed draft, retries exact IDs and supports toggle/remove", async () => {
		const held = gate();
		let attempts = 0,
			schedule: Record<string, unknown> | null = null;
		const template = {
			id: "template-a",
			name: "Selected template",
			serviceType: "RADARR",
			config: { customFormats: [], customFormatGroups: [] },
		};
		transport((event) => {
			if (event.url === "/api/trash-guides/templates/template-a/stats")
				return response({
					stats: {
						templateId: "template-a",
						usageCount: 1,
						formatCount: 0,
						groupCount: 0,
						isActive: true,
						activeInstanceCount: 1,
						instances: [
							{
								instanceId: "radarr-a",
								instanceName: "Synthetic Radarr",
								instanceType: "RADARR",
								hasActiveSchedule: !!schedule,
								syncStrategy: "manual",
								hasMapping: true,
							},
						],
					},
				});
			if (event.url === "/api/trash-guides/templates/template-a") return response({ template });
			if (
				event.url ===
				"/api/trash-guides/schedules/by-link?templateId=template-a&instanceId=radarr-a"
			)
				return response({ success: true, data: schedule });
			if (event.url === "/api/trash-guides/schedules" && event.method === "POST") {
				attempts++;
				if (attempts === 1) return held.promise;
				schedule = { id: "schedule-a", ...event.body, lastRunAt: null, nextRunAt: null };
				return response({ success: true, data: schedule });
			}
			if (event.url.endsWith("/schedules/schedule-a") && event.method === "PUT") {
				schedule = { ...schedule, ...event.body };
				return response({ success: true, data: schedule });
			}
			if (event.url.endsWith("/schedules/schedule-a") && event.method === "DELETE") {
				schedule = null;
				return response({ success: true, message: "Removed" });
			}
		});
		mount(<TemplateStats templateId="template-a" templateName="Selected template" />);
		fireEvent.click(screen.getByRole("button", { name: /Template Stats/ }));
		fireEvent.click(await screen.findByTitle("Configure sync schedule"));
		const dialog = await screen.findByRole("dialog", { name: "Create Sync Schedule" });
		fireEvent.click(within(dialog).getByRole("button", { name: "Daily" }));
		fireEvent.click(within(dialog).getByRole("button", { name: "Create Schedule" }));
		await waitFor(() => expect(attempts).toBe(1));
		await act(async () => held.release(response({ message: "Schedule refused" }, 503)));
		await screen.findAllByText("Schedule refused");
		fireEvent.click(within(dialog).getByRole("button", { name: "Create Schedule" }));
		await waitFor(() => expect(screen.queryByRole("dialog")).not.toBeInTheDocument());
		expect(events.filter((event) => event.method === "POST").map((event) => event.body)).toEqual([
			{
				templateId: "template-a",
				instanceId: "radarr-a",
				frequency: "DAILY",
				enabled: true,
				autoApply: false,
				notifyUser: true,
			},
			{
				templateId: "template-a",
				instanceId: "radarr-a",
				frequency: "DAILY",
				enabled: true,
				autoApply: false,
				notifyUser: true,
			},
		]);
		fireEvent.click(screen.getByTitle("Configure sync schedule"));
		const edit = await screen.findByRole("dialog", { name: "Edit Sync Schedule" });
		fireEvent.click(within(edit).getByRole("checkbox", { name: /Enable Schedule/ }));
		fireEvent.click(within(edit).getByRole("button", { name: "Update Schedule" }));
		await waitFor(() => expect(screen.queryByRole("dialog")).not.toBeInTheDocument());
		expect(events.find((event) => event.method === "PUT")!.body).toEqual({
			frequency: "DAILY",
			enabled: false,
			autoApply: false,
			notifyUser: true,
		});
		fireEvent.click(screen.getByTitle("Configure sync schedule"));
		const remove = await screen.findByRole("dialog", { name: "Edit Sync Schedule" });
		fireEvent.click(within(remove).getByRole("button", { name: "Remove Schedule" }));
		expect(events.filter((event) => event.method === "DELETE")).toHaveLength(0);
		fireEvent.click(within(remove).getByRole("button", { name: "Confirm remove?" }));
		await waitFor(() => expect(screen.queryByRole("dialog")).not.toBeInTheDocument());
		expect(events.filter((event) => event.method === "DELETE")).toEqual([
			{ url: "/api/trash-guides/schedules/schedule-a", method: "DELETE", body: null },
		]);
	});
});
