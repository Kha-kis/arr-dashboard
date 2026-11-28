import type { NotificationRuleResponse } from "@arr/shared";
import { QueryClient, QueryClientProvider } from "@tanstack/react-query";
import {
	act,
	cleanup,
	fireEvent,
	render,
	renderHook,
	screen,
	waitFor,
	within,
} from "@testing-library/react";
import { afterEach, describe, expect, it, vi } from "vitest";
import { IncognitoProvider } from "../../../../contexts/IncognitoContext";
import { useUpdateRule } from "../../../../hooks/api/useNotifications";
import { NotificationRuleSaveUnverifiedError } from "../../../../lib/api-client/notifications";
import { notificationKeys } from "../../../../lib/query-keys";
import { ColorThemeProvider } from "../../../../providers/color-theme-provider";
import { NotificationRulesTab } from "../notification-rules-tab";

const original: NotificationRuleResponse = {
	id: "first-rule",
	name: "Synthetic first rule",
	enabled: false,
	priority: 13,
	action: "suppress",
	conditions: [{ field: "eventType", operator: "equals", value: "HUNT_COMPLETED" }],
	targetChannelIds: null,
	throttleMinutes: null,
	quietHoursStart: null,
	quietHoursEnd: null,
	quietHoursTimezone: null,
	createdAt: "2026-01-01T00:00:00.000Z",
	updatedAt: "2026-01-01T00:00:00.000Z",
};
const other: NotificationRuleResponse = {
	...original,
	id: "other-rule",
	name: "Synthetic other rule",
	enabled: true,
	priority: 21,
};
const acknowledged: NotificationRuleResponse = {
	...original,
	name: "Server-confirmed normalized rule",
	updatedAt: "2026-02-01T00:00:00.000Z",
};
const clients: QueryClient[] = [];
const releases: Array<() => void> = [];

function json(value: unknown, status = 200) {
	return new Response(JSON.stringify(value), {
		status,
		headers: { "Content-Type": "application/json" },
	});
}

// Only external fetch is synthetic: actual component, client, hooks, query
// cancellation/publication and providers exercise the consumer-visible contract.
function fixture(
	readMode: "pending" | "failed",
	writeFailure = false,
	priority = original.priority,
) {
	let current = [original, other];
	let allowReads = false;
	const writes: Array<{ method: string; path: string; payload: unknown }> = [];
	const reads: Array<{
		snapshot: NotificationRuleResponse[];
		resolve?: (response: Response) => void;
	}> = [];
	vi.stubGlobal("fetch", async (path: string, request: RequestInit = {}) => {
		const method = request.method ?? "GET";
		if (method === "GET") {
			if (path === "/api/notifications/channels") return json([]);
			if (path !== "/api/notifications/rules") throw new Error("Out-of-scope synthetic read");
			const record: (typeof reads)[number] = { snapshot: current };
			reads.push(record);
			if (allowReads) return json(current);
			if (readMode === "failed") return json({ message: "synthetic-private-reread-error" }, 503);
			return new Promise<Response>((resolve) => {
				record.resolve = resolve;
				releases.push(() => resolve(json(record.snapshot)));
			});
		}
		if (
			!(
				(method === "POST" && path === "/api/notifications/rules") ||
				((method === "PUT" || method === "DELETE") &&
					path === "/api/notifications/rules/first-rule")
			)
		)
			throw new Error("Out-of-scope synthetic mutation");
		writes.push({
			method,
			path,
			payload: request.body === undefined ? undefined : JSON.parse(String(request.body)),
		});
		if (writeFailure) return json({ message: "Synthetic write rejected" }, 409);
		if (method === "DELETE") {
			current = [other];
			return new Response(null, { status: 204 });
		}
		if (method === "POST") {
			const created = { ...acknowledged, id: "created-rule", enabled: true, priority };
			// The real list endpoint returns lower numeric priorities first.
			current = [...current, created].sort((a, b) => a.priority - b.priority);
			return json(created, 201);
		}
		const updated = { ...acknowledged, priority };
		current = [updated, other].sort((a, b) => a.priority - b.priority);
		return json(updated);
	});
	const client = new QueryClient({
		defaultOptions: { queries: { retry: false, gcTime: 0 }, mutations: { retry: false } },
	});
	clients.push(client);
	client.setQueryData(notificationKeys.rules, [original, other]);
	client.setQueryData(notificationKeys.channels, []);
	render(
		<QueryClientProvider client={client}>
			<ColorThemeProvider>
				<IncognitoProvider>
					<NotificationRulesTab />
				</IncognitoProvider>
			</ColorThemeProvider>
		</QueryClientProvider>,
	);
	return {
		client,
		writes,
		reads,
		allowReads() {
			allowReads = true;
		},
		async releaseRead(index: number, rows?: NotificationRuleResponse[]) {
			const record = reads[index];
			if (!record?.resolve) throw new Error("Synthetic pending read missing");
			await act(async () => record.resolve?.(json(rows ?? record.snapshot)));
		},
	};
}

function row(name: string) {
	const element = screen.getByText(name).closest(".rounded-xl");
	if (!(element instanceof HTMLElement)) throw new Error("Actual rule row missing");
	return within(element);
}
function cached(client: QueryClient) {
	return client.getQueryData<NotificationRuleResponse[]>(notificationKeys.rules);
}
function mutate(operation: "create" | "update" | "delete", priority?: number) {
	if (operation === "delete") {
		fireEvent.click(row(original.name).getByTitle("Delete rule"));
		fireEvent.click(row(original.name).getByTitle("Click again to confirm"));
		return;
	}
	if (operation === "create") fireEvent.click(screen.getByRole("button", { name: "Add Rule" }));
	else fireEvent.click(row(original.name).getByTitle("Edit rule"));
	fireEvent.change(screen.getByPlaceholderText("e.g. Suppress hunt noise"), {
		target: { value: "Submitted draft differs from server" },
	});
	if (operation === "create")
		fireEvent.change(screen.getByPlaceholderText("Value"), { target: { value: "HUNT_COMPLETED" } });
	if (priority !== undefined)
		fireEvent.change(screen.getByRole("spinbutton"), { target: { value: String(priority) } });
	fireEvent.click(
		screen.getByRole("button", { name: operation === "create" ? "Create Rule" : "Update Rule" }),
	);
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

describe("acknowledged rule mutations survive independent list rereads", () => {
	it.each([
		["create", "pending"],
		["create", "failed"],
		["update", "pending"],
		["update", "failed"],
		["delete", "pending"],
		["delete", "failed"],
	] as const)(
		"%s preserves acknowledged cache and read-only recovery when reread is %s",
		async (operation, readMode) => {
			const value = fixture(readMode);
			mutate(operation);
			await waitFor(() => expect(value.writes).toHaveLength(1));
			await waitFor(() => expect(value.reads).toHaveLength(1));
			if (readMode === "failed")
				await waitFor(() =>
					expect(value.client.getQueryState(notificationKeys.rules)?.status).toBe("error"),
				);
			else expect(value.client.getQueryState(notificationKeys.rules)?.fetchStatus).toBe("fetching");
			const expected =
				operation === "create"
					? [original, { ...acknowledged, id: "created-rule", enabled: true }, other]
					: operation === "update"
						? [acknowledged, other]
						: [other];
			expect.soft(cached(value.client)).toEqual(expected);
			if (operation !== "delete") {
				await waitFor(() =>
					expect(
						screen.queryByRole("button", { name: /^(Create|Update) Rule$/ }),
					).not.toBeInTheDocument(),
				);
				expect.soft(screen.queryByText(acknowledged.name)).toBeInTheDocument();
			} else expect.soft(screen.queryByText(original.name)).not.toBeInTheDocument();
			expect.soft(screen.queryByText(other.name)).toBeInTheDocument();
			expect
				.soft(screen.queryByText("Submitted draft differs from server"))
				.not.toBeInTheDocument();
			if (readMode === "failed") {
				expect.soft(screen.queryByRole("alert")).toHaveTextContent(/last-known.*refresh failed/i);
				expect.soft(screen.queryByText("synthetic-private-reread-error")).not.toBeInTheDocument();
				const retry = screen.queryByRole("button", { name: "Try again" });
				expect(retry).toBeInTheDocument();
				value.allowReads();
				fireEvent.click(retry!);
				await waitFor(() =>
					expect(value.client.getQueryState(notificationKeys.rules)?.status).toBe("success"),
				);
				expect(value.reads).toHaveLength(2);
			} else {
				expect.soft(screen.queryByRole("status")).toHaveTextContent(/last-known.*refresh/i);
				await value.releaseRead(0);
			}
			await waitFor(() => expect(cached(value.client)).toEqual(expected));
			expect(value.writes).toHaveLength(1);
			expect(value.writes[0]).toMatchObject({
				method: operation === "create" ? "POST" : operation === "update" ? "PUT" : "DELETE",
			});
			if (operation === "delete") expect(value.writes[0]!.payload).toBeUndefined();
			if (operation !== "delete") expect(screen.getByText(acknowledged.name)).toBeInTheDocument();
			expect(screen.getByText(other.name)).toBeInTheDocument();
			expect(screen.queryByRole("alert")).not.toBeInTheDocument();
		},
	);

	it.each([
		["create", "pending"],
		["create", "failed"],
		["update", "pending"],
		["update", "failed"],
	] as const)(
		"%s publishes execution-order priority while reread is %s",
		async (operation, readMode) => {
			const priority = operation === "create" ? 0 : 25;
			const value = fixture(readMode, false, priority);
			const previous = cached(value.client);
			mutate(operation, priority);
			await waitFor(() => expect(value.reads).toHaveLength(1));
			if (readMode === "failed")
				await waitFor(() =>
					expect(value.client.getQueryState(notificationKeys.rules)?.status).toBe("error"),
				);
			const confirmed = {
				...acknowledged,
				priority,
				...(operation === "create" && { id: "created-rule", enabled: true }),
			};
			const expected = operation === "create" ? [confirmed, original, other] : [other, confirmed];
			expect.soft(cached(value.client)).toEqual(expected);
			const first = screen.getByText(operation === "create" ? acknowledged.name : other.name);
			const second = screen.getByText(operation === "create" ? original.name : acknowledged.name);
			expect
				.soft(first.compareDocumentPosition(second) & Node.DOCUMENT_POSITION_FOLLOWING)
				.toBeTruthy();
			expect(previous).toEqual([original, other]);
			expect(value.writes).toHaveLength(1);
			expect(value.writes[0]!.payload).toMatchObject({ priority });
			if (readMode === "pending") await value.releaseRead(0);
			else {
				value.allowReads();
				fireEvent.click(screen.getByRole("button", { name: "Try again" }));
			}
			await waitFor(() =>
				expect(value.client.getQueryState(notificationKeys.rules)?.fetchStatus).toBe("idle"),
			);
			expect(cached(value.client)).toEqual(expected);
			expect(value.writes).toHaveLength(1);
		},
	);

	it("an older in-flight GET cannot overwrite acknowledgement; a newer GET may publish newer truth", async () => {
		const value = fixture("pending");
		act(() => {
			void value.client.refetchQueries({ queryKey: notificationKeys.rules });
		});
		await waitFor(() => expect(value.reads).toHaveLength(1));
		mutate("update");
		await waitFor(() => expect(value.reads).toHaveLength(2));
		expect.soft(cached(value.client)).toEqual([acknowledged, other]);
		await value.releaseRead(0);
		expect.soft(cached(value.client)).toEqual([acknowledged, other]);
		const newer = { ...acknowledged, enabled: true, name: "Newer independently read rule" };
		await value.releaseRead(1, [newer, other]);
		await screen.findByText(newer.name);
		expect(cached(value.client)).toEqual([newer, other]);
		expect(value.writes).toHaveLength(1);
	});

	it.each(["create", "update", "delete"] as const)(
		"failed %s never publishes an unacknowledged change or refetches",
		async (operation) => {
			const value = fixture("failed", true);
			mutate(operation);
			await waitFor(() =>
				expect(value.client.getMutationCache().getAll()[0]?.state.status).toBe("error"),
			);
			expect(cached(value.client)).toEqual([original, other]);
			expect(value.reads).toHaveLength(0);
			expect(value.writes).toHaveLength(1);
			expect(screen.getByText(original.name)).toBeInTheDocument();
			if (operation !== "delete")
				expect(screen.getByPlaceholderText("e.g. Suppress hunt noise")).toHaveValue(
					"Submitted draft differs from server",
				);
		},
	);

	it.each(["missing list", "missing target", "different response id"] as const)(
		"update cannot invent or modify unrelated cached rows: %s",
		async (scenario) => {
			const client = new QueryClient({ defaultOptions: { mutations: { retry: false } } });
			clients.push(client);
			const previous =
				scenario === "missing list"
					? undefined
					: scenario === "missing target"
						? [other]
						: [original, other];
			if (previous) client.setQueryData(notificationKeys.rules, previous);
			vi.stubGlobal("fetch", async (path: string, request: RequestInit) => {
				expect(path).toBe("/api/notifications/rules/first-rule");
				expect(request.method).toBe("PUT");
				return json({
					...acknowledged,
					id: scenario === "different response id" ? other.id : original.id,
				});
			});
			const { result } = renderHook(() => useUpdateRule(), {
				wrapper: ({ children }) => (
					<QueryClientProvider client={client}>{children}</QueryClientProvider>
				),
			});
			await act(async () => {
				const mutation = result.current.mutateAsync({
					id: original.id,
					data: { name: "Unconfirmed request name" },
				});
				if (scenario === "different response id") {
					await expect(mutation).rejects.toBeInstanceOf(NotificationRuleSaveUnverifiedError);
				} else await mutation;
			});
			if (scenario === "different response id") {
				await waitFor(() => expect(result.current.isError).toBe(true));
				expect(result.current.error).toBeInstanceOf(NotificationRuleSaveUnverifiedError);
			}
			expect(cached(client)).toEqual(previous);
		},
	);
});
