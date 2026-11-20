import { writeFileSync } from "node:fs";
import { join } from "node:path";
import { QueryClient, QueryClientProvider } from "@tanstack/react-query";
import { act, cleanup, fireEvent, render, screen, waitFor, within } from "@testing-library/react";
import { afterAll, afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { Toaster, toast } from "../../../../components/ui/toast";
import { IncognitoProvider } from "../../../../contexts/IncognitoContext";
import { ColorThemeProvider } from "../../../../providers/color-theme-provider";
import type { QueueCleanerConfigWithInstance } from "../../lib/queue-cleaner-types";
import { QueueCleanerClient } from "../queue-cleaner-client";

type Request = { url: string; method: string; body: unknown };
function fixture(instanceId: string): QueueCleanerConfigWithInstance {
	return {
		id: `config-${instanceId}`,
		instanceId,
		instanceName: "Synthetic duplicate",
		service: "radarr",
		enabled: true,
		intervalMins: 30,
		stalledEnabled: false,
		stalledThresholdMins: 60,
		failedEnabled: true,
		slowEnabled: false,
		slowSpeedThreshold: 100,
		slowGracePeriodMins: 30,
		errorPatternsEnabled: false,
		errorPatterns: null,
		fileExtensionAllowlistEnabled: false,
		allowedFileExtensions: null,
		strikeSystemEnabled: false,
		maxStrikes: 3,
		strikeDecayHours: 24,
		quiAwareMode: true,
		lastSeedProtection: true,
		seedingTimeoutEnabled: false,
		seedingTimeoutHours: 72,
		estimatedCompletionEnabled: false,
		estimatedCompletionMultiplier: 2,
		importPendingEnabled: false,
		importPendingThresholdMins: 60,
		importBlockCleanupLevel: "safe",
		importBlockPatternMode: "defaults",
		importBlockPatterns: null,
		autoImportEnabled: false,
		autoImportMaxAttempts: 2,
		autoImportCooldownMins: 30,
		autoImportSafeOnly: true,
		autoImportCustomPatterns: null,
		autoImportNeverPatterns: null,
		skipFutureEpisodes: true,
		whitelistEnabled: false,
		whitelistPatterns: null,
		removeFromClient: false,
		addToBlocklist: false,
		searchAfterRemoval: false,
		changeCategoryEnabled: false,
		dryRunMode: false,
		maxRemovalsPerRun: 10,
		minQueueAgeMins: 5,
		lastRunAt: null,
		lastRunItemsCleaned: 0,
		lastRunItemsSkipped: 0,
		createdAt: "2026-10-25T12:00:00Z",
		updatedAt: "2026-10-25T12:00:00Z",
	};
}
const instances = ["source-a", "source-b"].map((id) => ({
	id,
	label: "Synthetic duplicate",
	service: "radarr",
}));
const json = (body: unknown, status = 200) =>
	new Response(status === 204 ? null : JSON.stringify(body), {
		status,
		headers: { "content-type": "application/json" },
	});
let configs: QueueCleanerConfigWithInstance[];
let requests: Request[];
let clients: QueryClient[];
let gate: ReturnType<typeof deferred> | null;
let saveRefused: boolean;
let schedulerRefused: boolean;
let schedulerRunning: boolean;
let active: Set<Promise<Response>>;
const receipts: unknown[] = [];
function deferred() {
	let release!: () => void;
	const promise = new Promise<void>((resolve) => {
		release = resolve;
	});
	return { promise, release };
}
const writes = () => requests.filter((request) => request.method !== "GET");
beforeEach(() => {
	localStorage.clear();
	configs = [fixture("source-a"), fixture("source-b")];
	requests = [];
	clients = [];
	active = new Set();
	gate = null;
	saveRefused = false;
	schedulerRefused = false;
	schedulerRunning = true;
	vi.stubGlobal(
		"fetch",
		vi.fn((url: string, options?: RequestInit) => {
			const request = {
				url,
				method: options?.method ?? "GET",
				body: options?.body ? JSON.parse(String(options.body)) : null,
			};
			requests.push(request);
			const task = (async () => {
				if (request.method !== "GET" && gate) await gate.promise;
				if (url === "/api/queue-cleaner/status")
					return json({
						schedulerRunning,
						schedulerHealthy: true,
						schedulerLastError: null,
						instances: instances.map((instance) => ({
							instanceId: instance.id,
							instanceName: instance.label,
							service: instance.service,
							enabled: true,
							dryRunMode: false,
							lastRunAt: null,
							lastRunItemsCleaned: 0,
							lastRunItemsSkipped: 0,
							cleanedToday: 0,
							skippedToday: 0,
							hasConfig: configs.some((config) => config.instanceId === instance.id),
						})),
					});
				if (url === "/api/queue-cleaner/configs" && request.method === "GET")
					return json({ configs, instances });
				if (url === "/api/queue-cleaner/configs" && request.method === "POST") {
					const instanceId = (request.body as { instanceId: string }).instanceId;
					const created = fixture(instanceId);
					configs.push(created);
					return json(created, 201);
				}
				if (url === "/api/queue-cleaner/configs/source-b" && request.method === "PATCH") {
					if (saveRefused) return json({ error: "Synthetic save refused" }, 503);
					const updated = {
						...fixture("source-b"),
						...(request.body as object),
						updatedAt: "2026-10-25T12:01:00Z",
					};
					configs = configs.map((config) => (config.instanceId === "source-b" ? updated : config));
					return json(updated);
				}
				if (url === "/api/queue-cleaner/configs/source-b" && request.method === "DELETE") {
					configs = configs.filter((config) => config.instanceId !== "source-b");
					return json(null, 204);
				}
				if (url === "/api/queue-cleaner/scheduler/toggle") {
					if (!schedulerRefused) schedulerRunning = false;
					return json(
						schedulerRefused
							? { error: "Synthetic private scheduler details" }
							: { running: false },
						schedulerRefused ? 503 : 200,
					);
				}
				throw new Error(`Unexpected synthetic request ${request.method} ${url}`);
			})();
			active.add(task);
			void task.then(
				() => active.delete(task),
				() => active.delete(task),
			);
			return task;
		}),
	);
});
afterEach(async () => {
	gate?.release();
	await act(async () => {
		await Promise.allSettled([...active]);
	});
	await waitFor(() =>
		expect(
			clients
				.flatMap((client) => client.getMutationCache().getAll())
				.some((mutation) => mutation.state.status === "pending"),
		).toBe(false),
	);
	receipts.push({
		test: expect.getState().currentTestName,
		requests,
		heldWorkJoined: active.size === 0,
	});
	toast.dismiss();
	cleanup();
	clients.forEach((client) => {
		client.clear();
	});
	vi.unstubAllGlobals();
});
afterAll(() => {
	if (process.env.V4_EVIDENCE_ROOT)
		writeFileSync(
			join(process.env.V4_EVIDENCE_ROOT, "queue-cleaner-config-requests.json"),
			JSON.stringify(receipts, null, 2),
		);
});
async function show() {
	const client = new QueryClient({
		defaultOptions: { queries: { retry: false }, mutations: { retry: false } },
	});
	clients.push(client);
	const view = render(
		<QueryClientProvider client={client}>
			<ColorThemeProvider>
				<IncognitoProvider>
					<QueueCleanerClient />
					<Toaster />
				</IncognitoProvider>
			</ColorThemeProvider>
		</QueryClientProvider>,
	);
	fireEvent.click(await screen.findByRole("button", { name: "Configuration" }));
	return { client, ...view };
}
function cards() {
	return screen
		.getAllByRole("heading", { name: "Synthetic duplicate", level: 4 })
		.map((heading) => heading.closest('[class~="group/config"]'))
		.filter((card): card is HTMLElement => card instanceof HTMLElement);
}
const interval = (card: HTMLElement) =>
	card.querySelector('input[id="config-input-check-interval"]') as HTMLInputElement;
const limit = (card: HTMLElement) =>
	card.querySelector('input[id="config-input-max-removals-per-run"]') as HTMLInputElement;

describe("maintained Queue Cleaner configuration action recovery", () => {
	// Catches wrong same-named source creation and duplicate held create submissions.
	it("M1 creates only the chosen unconfigured source and reads the returned config without a duplicate", async () => {
		configs = [fixture("source-a")];
		await show();
		const button = await screen.findByRole("button", { name: "Configure" });
		gate = deferred();
		fireEvent.click(button);
		await waitFor(() => expect(writes()).toHaveLength(1));
		await waitFor(() => expect(button).toBeDisabled());
		fireEvent.click(button);
		expect(writes()).toEqual([
			{ url: "/api/queue-cleaner/configs", method: "POST", body: { instanceId: "source-b" } },
		]);
		await act(async () => {
			gate!.release();
		});
		await waitFor(() => expect(cards()).toHaveLength(2));
		expect(configs.find((config) => config.instanceId === "source-a")).toEqual(fixture("source-a"));
		expect(writes()).toHaveLength(1);
	});

	it("M1 refused save preserves chosen-source draft; explicit save/readback and confirmed delete affect only it", async () => {
		await show();
		await waitFor(() => expect(cards()).toHaveLength(2));
		let card = cards()[1]!;
		fireEvent.change(interval(card), { target: { value: "17" } });
		fireEvent.change(limit(card), { target: { value: "3" } });
		fireEvent.click(within(card).getAllByRole("switch")[1]!);
		gate = deferred();
		saveRefused = true;
		const save = within(card).getByRole("button", { name: "Save" });
		fireEvent.click(save);
		await waitFor(() => expect(writes()).toHaveLength(1));
		await waitFor(() => expect(save).toBeDisabled());
		fireEvent.click(save);
		expect(writes()).toHaveLength(1);
		expect(writes()[0]).toMatchObject({
			url: "/api/queue-cleaner/configs/source-b",
			method: "PATCH",
			body: {
				intervalMins: 17,
				maxRemovalsPerRun: 3,
				dryRunMode: true,
				removeFromClient: false,
				lastSeedProtection: true,
			},
		});
		await act(async () => {
			gate!.release();
		});
		await screen.findByText("Synthetic save refused");
		expect(interval(card)).toHaveValue(17);
		expect(limit(card)).toHaveValue(3);
		await waitFor(() => expect(save).toBeEnabled());
		saveRefused = false;
		gate = null;
		fireEvent.click(save);
		await screen.findByText(/Config updated for/);
		await waitFor(() => {
			card = cards()[1]!;
			expect(within(card).getByRole("button", { name: "Save" })).toBeDisabled();
		});
		expect(interval(card)).toHaveValue(17);
		fireEvent.click(within(card).getByRole("button", { name: "Delete" }));
		expect(writes()).toHaveLength(2);
		fireEvent.click(within(card).getByRole("button", { name: "Confirm Delete?" }));
		await screen.findByRole("button", { name: "Configure" });
		expect(writes().map(({ url, method }) => ({ url, method }))).toEqual([
			{ url: "/api/queue-cleaner/configs/source-b", method: "PATCH" },
			{ url: "/api/queue-cleaner/configs/source-b", method: "PATCH" },
			{ url: "/api/queue-cleaner/configs/source-b", method: "DELETE" },
		]);
		expect(configs).toEqual([fixture("source-a")]);
	});

	it("M2 held scheduler toggle reports the actual response; later refusal stays generic without hidden replay", async () => {
		await show();
		const button = await screen.findByRole("button", { name: "Toggle" });
		gate = deferred();
		fireEvent.click(button);
		await waitFor(() => expect(writes()).toHaveLength(1));
		await waitFor(() => expect(button).toBeDisabled());
		fireEvent.click(button);
		expect(writes()).toHaveLength(1);
		await act(async () => {
			gate!.release();
		});
		await screen.findByText("Scheduler stopped");
		await waitFor(() => expect(screen.getByRole("button", { name: "Toggle" })).toBeEnabled());
		gate = null;
		schedulerRefused = true;
		fireEvent.click(screen.getByRole("button", { name: "Toggle" }));
		await screen.findByText("Failed to toggle scheduler");
		expect(screen.queryByText("Synthetic private scheduler details")).not.toBeInTheDocument();
		expect(writes()).toEqual([
			{ url: "/api/queue-cleaner/scheduler/toggle", method: "POST", body: {} },
			{ url: "/api/queue-cleaner/scheduler/toggle", method: "POST", body: {} },
		]);
		expect(configs).toEqual([fixture("source-a"), fixture("source-b")]);
	});
});
