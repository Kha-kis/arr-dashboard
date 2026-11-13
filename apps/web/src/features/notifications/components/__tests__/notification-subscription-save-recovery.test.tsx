import type { SubscriptionGrid as Grid } from "@arr/shared";
import { QueryClient, QueryClientProvider } from "@tanstack/react-query";
import { act, cleanup, fireEvent, render, screen, waitFor } from "@testing-library/react";
import { afterEach, describe, expect, it, vi } from "vitest";
import { IncognitoProvider } from "../../../../contexts/IncognitoContext";
import { notificationsApi } from "../../../../lib/api-client/notifications";
import { notificationKeys } from "../../../../lib/query-keys";
import { ColorThemeProvider } from "../../../../providers/color-theme-provider";
import { SubscriptionGrid } from "../subscription-grid";

// Hand-authored transport truth; no production modules are mocked.
const initial: Grid = {
	channels: [
		{ id: "first", name: "Synthetic first", type: "DISCORD" },
		{ id: "second", name: "Synthetic second", type: "DISCORD" },
	],
	events: ["HUNT_COMPLETED", "BACKUP_FAILED"],
	subscriptions: [
		{ channelId: "first", eventType: "HUNT_COMPLETED" },
		{ channelId: "second", eventType: "BACKUP_FAILED" },
	],
};
const committed: Grid = {
	channels: [
		{ id: "first", name: "Synthetic first", type: "DISCORD" },
		{ id: "second", name: "Synthetic second", type: "DISCORD" },
	],
	events: ["HUNT_COMPLETED", "BACKUP_FAILED"],
	subscriptions: [
		{ channelId: "first", eventType: "BACKUP_FAILED" },
		{ channelId: "second", eventType: "BACKUP_FAILED" },
	],
};
const filtered: Grid = {
	channels: [{ id: "second", name: "Synthetic second", type: "DISCORD" }],
	events: ["HUNT_COMPLETED", "BACKUP_FAILED"],
	subscriptions: [{ channelId: "second", eventType: "BACKUP_FAILED" }],
};
const clients: QueryClient[] = [];
const releases: Array<() => void> = [];
const path = "/api/notifications/subscriptions";
const entry = { channelId: "first", eventType: "HUNT_COMPLETED", enabled: false } as const;
function json(value: unknown, status = 200) {
	return new Response(JSON.stringify(value), {
		status,
		headers: { "Content-Type": "application/json" },
	});
}

function fixture(options: {
	read: "pending" | "failed" | "success";
	initiallyUnknown?: boolean;
	writeFailure?: boolean;
	putStatus?: number;
	acknowledgement?: unknown;
	holdWrite?: boolean;
	readValue?: unknown;
	mutationRetry?: number;
}) {
	let readMode = options.read,
		readValue: unknown = options.readValue ?? committed;
	let releaseWrite!: () => void;
	const writeGate = new Promise<void>((resolve) => {
		releaseWrite = resolve;
	});
	if (options.holdWrite) releases.push(releaseWrite);
	const reads: Array<{ resolve?: (response: Response) => void }> = [];
	const writes: Array<{ payload: unknown; credentials: unknown; status: number }> = [];
	const outOfScope: string[] = [];
	vi.stubGlobal("fetch", async (input: RequestInfo | URL, request: RequestInit = {}) => {
		if (input !== path || !["GET", "PUT"].includes(request.method ?? "GET")) {
			outOfScope.push(String(input));
			throw new Error("Out-of-scope synthetic transport");
		}
		if ((request.method ?? "GET") === "GET") {
			const record: (typeof reads)[number] = {};
			reads.push(record);
			if (readMode === "success") return json(readValue);
			if (readMode === "failed") return json({ message: "synthetic-private-read-error" }, 503);
			return new Promise<Response>((resolve) => {
				record.resolve = resolve;
				releases.push(() => resolve(json(initial)));
			});
		}
		const status = options.writeFailure ? (options.putStatus ?? 409) : 200;
		writes.push({
			payload: JSON.parse(String(request.body)),
			credentials: request.credentials,
			status,
		});
		if (options.holdWrite) await writeGate;
		return options.writeFailure
			? json({ message: "synthetic-private-write-error" }, status)
			: json(
					Object.hasOwn(options, "acknowledgement")
						? options.acknowledgement
						: { success: true, grid: committed, omittedCount: 0 },
				);
	});
	const client = new QueryClient({
		defaultOptions: {
			queries: { retry: false, gcTime: 0 },
			mutations: { retry: options.mutationRetry ?? false, retryDelay: 0 },
		},
	});
	clients.push(client);
	if (!options.initiallyUnknown) client.setQueryData(notificationKeys.subscriptions, initial);
	render(
		<QueryClientProvider client={client}>
			<ColorThemeProvider>
				<IncognitoProvider>
					<SubscriptionGrid />
				</IncognitoProvider>
			</ColorThemeProvider>
		</QueryClientProvider>,
	);
	return {
		client,
		reads,
		writes,
		outOfScope,
		async releaseWrite() {
			await act(async () => releaseWrite());
		},
		allowRead(value: unknown = committed) {
			readMode = "success";
			readValue = value;
		},
		async releaseRead(index: number, value: unknown) {
			const record = reads[index];
			if (!record?.resolve) throw new Error("Expected pending synthetic read");
			await act(async () => record.resolve?.(json(value)));
		},
	};
}
function cached(value: ReturnType<typeof fixture>) {
	return value.client.getQueryData<Grid>(notificationKeys.subscriptions);
}
function edit() {
	fireEvent.click(
		screen.getByRole("button", { name: "Unsubscribe Synthetic first from Hunt Completed" }),
	);
	fireEvent.click(
		screen.getByRole("button", { name: "Subscribe Synthetic first from Backup Failed" }),
	);
}
function submit() {
	edit();
	fireEvent.click(screen.getByRole("button", { name: "Save Changes" }));
}
function draftCell() {
	return screen.getByRole("button", { name: "Unsubscribe Synthetic first from Backup Failed" });
}
async function settled(value: ReturnType<typeof fixture>, status = "success") {
	await waitFor(() =>
		expect(value.client.getMutationCache().getAll()[0]?.state.status).toBe(status),
	);
	expect(value.writes).toEqual([
		{
			payload: {
				subscriptions: [
					{ channelId: "first", eventType: "HUNT_COMPLETED", enabled: false },
					{ channelId: "first", eventType: "BACKUP_FAILED", enabled: true },
				],
			},
			credentials: "include",
			status: value.writes[0]?.status === 409 ? 409 : 200,
		},
	]);
	expect(value.outOfScope).toEqual([]);
}
afterEach(async () => {
	cleanup();
	await act(async () => {
		for (const release of releases.splice(0)) release();
	});
	for (const client of clients.splice(0)) client.clear();
	vi.unstubAllGlobals();
	localStorage.clear();
});

describe("validated subscription save through actual client, hook, component and cache", () => {
	it("does not replay PUT even when the surrounding cache defaults permit mutation retries", async () => {
		const value = fixture({ read: "failed", writeFailure: true, mutationRetry: 1 });
		submit();
		await settled(value, "error");
		expect(value.writes).toHaveLength(1);
		expect(draftCell()).toBeEnabled();
	});
	it("preserves stored legacy tags outside editable events without corrupting the local map", async () => {
		const serverGrid = {
			...committed,
			subscriptions: [
				...committed.subscriptions,
				{ channelId: "second", eventType: "__proto__" },
				{ channelId: "first", eventType: "constructor" },
			],
		};
		const value = fixture({
			read: "pending",
			acknowledgement: { success: true, grid: serverGrid, omittedCount: 0 },
		});
		submit();
		await settled(value);
		expect(cached(value)).toEqual(serverGrid);
		expect(draftCell()).toBeEnabled();
		expect(screen.queryByRole("button", { name: "Save Changes" })).not.toBeInTheDocument();
	});
	it.each(["pending", "failed"] as const)(
		"native committed grid confirms cells while background GET is %s",
		async (read) => {
			const value = fixture({ read });
			submit();
			await settled(value);
			expect(cached(value)).toEqual(committed);
			expect(screen.queryByRole("button", { name: "Save Changes" })).not.toBeInTheDocument();
			expect(draftCell()).toBeEnabled();
			await waitFor(() => expect(value.reads).toHaveLength(1));
			if (read === "failed") {
				await waitFor(() =>
					expect(screen.getByRole("alert")).toHaveTextContent(/last-known.*refresh failed/i),
				);
				expect(screen.getByText("Synthetic first")).toBeInTheDocument();
				value.allowRead();
				fireEvent.click(screen.getByRole("button", { name: "Try again" }));
				await waitFor(() => expect(value.reads).toHaveLength(2));
			} else expect(screen.getByRole("status")).toHaveTextContent(/last-known.*refresh/i);
			expect(value.writes).toHaveLength(1);
		},
	);
	it("uses the actual filtered owned grid and generic omitted count", async () => {
		const value = fixture({
			read: "pending",
			acknowledgement: { success: true, grid: filtered, omittedCount: 2 },
		});
		submit();
		await settled(value);
		expect(cached(value)).toEqual(filtered);
		expect(screen.queryByText("Synthetic first")).not.toBeInTheDocument();
		expect(screen.getByText(/2.*selection.*omitted/i)).toBeInTheDocument();
		expect(screen.queryByRole("button", { name: "Save Changes" })).not.toBeInTheDocument();
	});
	it("locks editable cells during pending PUT", async () => {
		const value = fixture({ read: "pending", holdWrite: true });
		submit();
		await waitFor(() => expect(value.writes).toHaveLength(1));
		expect(screen.getByRole("button", { name: "Save Changes" })).toBeDisabled();
		const later = screen.getByRole("button", {
			name: "Unsubscribe Synthetic second from Backup Failed",
		});
		expect(later).toBeDisabled();
		fireEvent.click(later);
		await value.releaseWrite();
		await settled(value);
		expect(later).toBeEnabled();
		expect(cached(value)).toEqual(committed);
	});
	it("legacy success remains pending with locked draft until validated GET confirms actual cells", async () => {
		const value = fixture({ read: "pending", acknowledgement: { success: true } });
		submit();
		await waitFor(() => expect(value.reads).toHaveLength(1));
		expect(cached(value)).toEqual(initial);
		expect(draftCell()).toBeDisabled();
		expect(screen.getByRole("button", { name: "Save Changes" })).toBeDisabled();
		await value.releaseRead(0, initial);
		await settled(value);
		expect(cached(value)).toEqual(initial);
		expect(
			screen.getByRole("button", { name: "Unsubscribe Synthetic first from Hunt Completed" }),
		).toBeEnabled();
		expect(screen.queryByRole("button", { name: "Save Changes" })).not.toBeInTheDocument();
		expect(screen.getByText(/omitted.*unknown/i)).toBeInTheDocument();
		expect(value.writes).toHaveLength(1);
	});
	it("failed legacy read and failed reload retain draft and lock; explicit valid reload discards draft without PUT replay", async () => {
		const value = fixture({ read: "failed", acknowledgement: { success: true } });
		submit();
		await settled(value, "error");
		expect(cached(value)).toEqual(initial);
		expect(draftCell()).toBeDisabled();
		expect(screen.getByRole("alert")).toHaveTextContent(/could not be verified/i);
		fireEvent.click(
			screen.getByRole("button", { name: /Reload saved subscriptions and discard draft/i }),
		);
		await waitFor(() => expect(value.reads).toHaveLength(2));
		expect(draftCell()).toBeDisabled();
		expect(cached(value)).toEqual(initial);
		value.allowRead(initial);
		fireEvent.click(
			screen.getByRole("button", { name: /Reload saved subscriptions and discard draft/i }),
		);
		await waitFor(() =>
			expect(screen.queryByRole("button", { name: "Save Changes" })).not.toBeInTheDocument(),
		);
		expect(
			screen.getByRole("button", { name: "Unsubscribe Synthetic first from Hunt Completed" }),
		).toBeEnabled();
		expect(value.reads).toHaveLength(3);
		expect(value.writes).toHaveLength(1);
		expect(screen.queryByText(/synthetic-private/i)).not.toBeInTheDocument();
	});
	it.each([
		{ success: false },
		{},
		{ success: "true" },
		null,
		{ success: true, grid: committed },
		{ success: true, omittedCount: 0 },
		{ success: true, grid: null, omittedCount: 0 },
		{ success: true, grid: committed, omittedCount: -1 },
		{ success: true, grid: committed, omittedCount: 3 },
		{ success: true, grid: committed, omittedCount: 0.5 },
		{ success: true, grid: committed, omittedCount: "0" },
	])(
		"invalid native/HTTP200 ACK %j retains locked draft without legacy fallback",
		async (acknowledgement) => {
			const value = fixture({ read: "pending", acknowledgement });
			submit();
			await settled(value, "error");
			expect(cached(value)).toEqual(initial);
			expect(draftCell()).toBeDisabled();
			expect(screen.getByRole("button", { name: "Save Changes" })).toBeDisabled();
			expect(screen.getByRole("alert")).toHaveTextContent(/could not be verified/i);
			expect(value.reads).toHaveLength(0);
			expect(value.writes).toHaveLength(1);
		},
	);
	it("ordinary failed PUT retains editable retryable draft without GET or cache publication", async () => {
		const value = fixture({ read: "failed", writeFailure: true });
		submit();
		await settled(value, "error");
		expect(cached(value)).toEqual(initial);
		expect(draftCell()).toBeEnabled();
		expect(screen.getByRole("button", { name: "Save Changes" })).toBeEnabled();
		expect(value.reads).toHaveLength(0);
	});
	it("background GET cannot erase draft or change its reference grid", async () => {
		const value = fixture({ read: "success", readValue: filtered });
		edit();
		await act(async () => {
			await value.client.refetchQueries({ queryKey: notificationKeys.subscriptions });
		});
		expect(cached(value)).toEqual(filtered);
		expect(draftCell()).toBeEnabled();
		expect(screen.getByText("Synthetic first")).toBeInTheDocument();
		fireEvent.click(screen.getByRole("button", { name: "Save Changes" }));
		await settled(value);
	});
	it("older in-flight GET is fenced from native committed publication", async () => {
		const value = fixture({ read: "pending" });
		act(() => {
			void value.client.refetchQueries({ queryKey: notificationKeys.subscriptions });
		});
		await waitFor(() => expect(value.reads).toHaveLength(1));
		submit();
		await settled(value);
		expect(cached(value)).toEqual(committed);
		await value.releaseRead(0, initial);
		expect(cached(value)).toEqual(committed);
		expect(draftCell()).toBeEnabled();
		expect(value.writes).toHaveLength(1);
	});
	it("initial unavailable GET has no known grid and recovers with GET only", async () => {
		const value = fixture({ read: "failed", initiallyUnknown: true });
		await waitFor(() => expect(screen.getByRole("alert")).toHaveTextContent(/unavailable/i));
		expect(cached(value)).toBeUndefined();
		expect(screen.queryByText("Synthetic first")).not.toBeInTheDocument();
		value.allowRead();
		fireEvent.click(screen.getByRole("button", { name: "Try again" }));
		await waitFor(() => expect(cached(value)).toEqual(committed));
		expect(value.reads).toHaveLength(2);
		expect(value.writes).toHaveLength(0);
		expect(value.outOfScope).toEqual([]);
	});
});

describe("accepted E1 correction boundaries", () => {
	it.each(["GET", "native", "legacy"] as const)(
		"SUB-R1 preserves existing nonempty untrimmed channel names through %s",
		async (mode) => {
			const nameGrid = {
				channels: [{ id: "first", name: " \t ", type: "DISCORD" }],
				events: ["HUNT_COMPLETED"],
				subscriptions: [{ channelId: "first", eventType: "HUNT_COMPLETED" }],
			};
			const requests: Array<[unknown, string]> = [];
			vi.stubGlobal("fetch", async (input: unknown, request: RequestInit = {}) => {
				const method = request.method ?? "GET";
				requests.push([input, method]);
				if (input !== path || !["GET", "PUT"].includes(method))
					throw new Error("Out-of-scope synthetic transport");
				return json(
					method === "GET"
						? nameGrid
						: mode === "native"
							? { success: true, grid: nameGrid, omittedCount: 0 }
							: { success: true },
				);
			});
			if (mode === "GET") {
				expect(await notificationsApi.getSubscriptions()).toEqual(nameGrid);
				expect(requests).toEqual([[path, "GET"]]);
			} else {
				expect(await notificationsApi.updateSubscriptions([entry])).toEqual({
					success: true,
					grid: nameGrid,
					omittedCount: mode === "native" ? 0 : null,
				});
				expect(requests).toEqual(
					mode === "native"
						? [[path, "PUT"]]
						: [
								[path, "PUT"],
								[path, "GET"],
							],
				);
			}
		},
	);

	it.each([408, 500, 502, 504, 302])(
		"SUB-R2 ambiguous HTTP %s locks retained draft until explicit valid GET without PUT replay",
		async (putStatus) => {
			const value = fixture({ read: "failed", writeFailure: true, putStatus });
			submit();
			await waitFor(() =>
				expect(value.client.getMutationCache().getAll()[0]?.state.status).toBe("error"),
			);
			expect(value.writes).toEqual([
				{
					payload: {
						subscriptions: [
							{ channelId: "first", eventType: "HUNT_COMPLETED", enabled: false },
							{ channelId: "first", eventType: "BACKUP_FAILED", enabled: true },
						],
					},
					credentials: "include",
					status: putStatus,
				},
			]);
			expect(value.reads).toHaveLength(0);
			expect(value.outOfScope).toEqual([]);
			expect(cached(value)).toEqual(initial);
			await waitFor(() => expect(draftCell()).toBeDisabled());
			expect(screen.getByRole("button", { name: "Save Changes" })).toBeDisabled();
			expect(screen.getByRole("alert")).toHaveTextContent(/could not be verified/i);
			expect(screen.queryByText(/synthetic-private/i)).not.toBeInTheDocument();
			fireEvent.click(screen.getByRole("button", { name: "Save Changes" }));
			fireEvent.click(
				screen.getByRole("button", { name: /Reload saved subscriptions and discard draft/i }),
			);
			await waitFor(() =>
				expect(value.client.getQueryState(notificationKeys.subscriptions)?.status).toBe("error"),
			);
			expect(value.reads).toHaveLength(1);
			expect(cached(value)).toEqual(initial);
			expect(draftCell()).toBeDisabled();
			value.allowRead(initial);
			fireEvent.click(
				screen.getByRole("button", { name: /Reload saved subscriptions and discard draft/i }),
			);
			await waitFor(() =>
				expect(screen.queryByRole("button", { name: "Save Changes" })).not.toBeInTheDocument(),
			);
			expect(
				screen.getByRole("button", { name: "Unsubscribe Synthetic first from Hunt Completed" }),
			).toBeEnabled();
			expect(value.reads).toHaveLength(2);
			expect(value.writes).toHaveLength(1);
			expect(value.outOfScope).toEqual([]);
		},
	);

	it.each(["pending", "failed"] as const)(
		"SUB-R3 last-known empty grid retains %s refresh status and GET-only recovery",
		async (read) => {
			const empty: Grid = {
				channels: [],
				events: ["HUNT_COMPLETED", "BACKUP_FAILED"],
				subscriptions: [],
			};
			const value = fixture({ read });
			await act(async () => value.client.setQueryData(notificationKeys.subscriptions, empty));
			await screen.findByText(/Create at least one notification channel/i);
			act(() => {
				void value.client.refetchQueries({ queryKey: notificationKeys.subscriptions });
			});
			await waitFor(() => expect(value.reads).toHaveLength(1));
			expect(cached(value)).toEqual(empty);
			expect(value.writes).toHaveLength(0);
			expect(value.outOfScope).toEqual([]);
			if (read === "pending") {
				expect(screen.getByRole("status")).toHaveTextContent(/last-known.*refresh/i);
				await value.releaseRead(0, committed);
			} else {
				await waitFor(() =>
					expect(screen.getByRole("alert")).toHaveTextContent(/last-known.*refresh failed/i),
				);
				value.allowRead();
				fireEvent.click(screen.getByRole("button", { name: "Try again" }));
			}
			await waitFor(() => expect(cached(value)).toEqual(committed));
			await waitFor(() =>
				expect(
					screen.queryByText(/Create at least one notification channel/i),
				).not.toBeInTheDocument(),
			);
			expect(value.writes).toHaveLength(0);
			expect(value.outOfScope).toEqual([]);
		},
	);

	it("SUB-R3 confirmed empty owned result still displays positive omitted-entry notice", async () => {
		const empty: Grid = {
			channels: [],
			events: ["HUNT_COMPLETED", "BACKUP_FAILED"],
			subscriptions: [],
		};
		const value = fixture({
			read: "pending",
			acknowledgement: { success: true, grid: empty, omittedCount: 2 },
		});
		submit();
		await settled(value);
		expect(cached(value)).toEqual(empty);
		expect(screen.getByText(/2.*selection.*omitted/i)).toBeInTheDocument();
		expect(screen.getByText(/Create at least one notification channel/i)).toBeInTheDocument();
		expect(screen.getByRole("status")).toHaveTextContent(/last-known.*refresh/i);
		expect(value.writes).toHaveLength(1);
		expect(value.outOfScope).toEqual([]);
	});
});
describe("subscription DTO admission and projection at the actual client boundary", () => {
	const malformedGrids: unknown[] = [
		null,
		{},
		{ ...initial, channels: [{ id: " ", name: "Synthetic", type: "DISCORD" }] },
		{ ...initial, channels: [initial.channels[0], initial.channels[0]] },
		{ ...initial, events: ["HUNT_COMPLETED", "HUNT_COMPLETED"] },
		{ ...initial, events: [" "] },
		{ ...initial, subscriptions: [{ channelId: "foreign", eventType: "HUNT_COMPLETED" }] },
		{ ...initial, subscriptions: [initial.subscriptions[0], initial.subscriptions[0]] },
		{ ...initial, subscriptions: [{ channelId: "first", eventType: "" }] },
	];
	it.each(malformedGrids)("malformed GET %j cannot become current state", async (grid) => {
		const methods: string[] = [];
		vi.stubGlobal("fetch", async (input: unknown, request: RequestInit = {}) => {
			if (input !== path) throw new Error("Out-of-scope transport");
			methods.push(request.method ?? "GET");
			return json(grid);
		});
		await expect(notificationsApi.getSubscriptions()).rejects.toThrow();
		expect(methods).toEqual(["GET"]);
	});
	it.each(malformedGrids)(
		"malformed native grid %j is unverified without fallback",
		async (grid) => {
			const methods: string[] = [];
			vi.stubGlobal("fetch", async (input: unknown, request: RequestInit = {}) => {
				if (input !== path) throw new Error("Out-of-scope transport");
				methods.push(request.method ?? "GET");
				return json({ success: true, grid, omittedCount: 0 });
			});
			await expect(notificationsApi.updateSubscriptions([entry])).rejects.toThrow(
				/could not be verified/i,
			);
			expect(methods).toEqual(["PUT"]);
		},
	);
	it("bodyless successful PUT remains unverified", async () => {
		const requests: unknown[] = [];
		vi.stubGlobal("fetch", async (input: unknown, request: RequestInit = {}) => {
			requests.push([input, request.method]);
			if (input !== path || request.method !== "PUT") throw new Error("Out-of-scope transport");
			return new Response(null, { status: 204 });
		});
		await expect(notificationsApi.updateSubscriptions([entry])).rejects.toThrow(
			/could not be verified/i,
		);
		expect(requests).toEqual([[path, "PUT"]]);
	});
	it("strips provider/config fields while preserving nonblank legacy tags for GET and native ACK", async () => {
		const raw = {
			channels: [
				{
					id: "first",
					name: "Synthetic first",
					type: "LEGACY_CHANNEL",
					config: { token: "synthetic-private" },
				},
			],
			events: ["HUNT_COMPLETED", "LEGACY_EDITABLE"],
			subscriptions: [
				{ channelId: "first", eventType: "LEGACY_STORED", provider: "synthetic-private" },
			],
			provider: "synthetic-private",
		};
		const projected = {
			channels: [{ id: "first", name: "Synthetic first", type: "LEGACY_CHANNEL" }],
			events: ["HUNT_COMPLETED", "LEGACY_EDITABLE"],
			subscriptions: [{ channelId: "first", eventType: "LEGACY_STORED" }],
		};
		const methods: string[] = [];
		vi.stubGlobal("fetch", async (input: unknown, request: RequestInit = {}) => {
			if (input !== path) throw new Error("Out-of-scope transport");
			methods.push(request.method ?? "GET");
			return json(
				request.method === "PUT"
					? { success: true, grid: raw, omittedCount: 0, config: "synthetic-private" }
					: raw,
			);
		});
		expect(await notificationsApi.getSubscriptions()).toEqual(projected);
		expect(await notificationsApi.updateSubscriptions([entry])).toEqual({
			success: true,
			grid: projected,
			omittedCount: 0,
		});
		expect(methods).toEqual(["GET", "PUT"]);
	});
	it("malformed legacy read cannot confirm success and performs just one read", async () => {
		const methods: string[] = [];
		vi.stubGlobal("fetch", async (input: unknown, request: RequestInit = {}) => {
			if (input !== path) throw new Error("Out-of-scope transport");
			methods.push(request.method ?? "GET");
			return json(request.method === "PUT" ? { success: true } : { ...initial, events: [null] });
		});
		await expect(notificationsApi.updateSubscriptions([entry])).rejects.toThrow(
			/could not be verified/i,
		);
		expect(methods).toEqual(["PUT", "GET"]);
	});
});
