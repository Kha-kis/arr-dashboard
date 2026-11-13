import type { ManualImportOperationStatus } from "@arr/shared";
import { QueryClient, QueryClientProvider } from "@tanstack/react-query";
import { act, cleanup, renderHook, waitFor } from "@testing-library/react";
import type { ReactNode } from "react";
import { afterEach, describe, expect, it, vi } from "vitest";
import { useManualImportProgressQuery } from "../useManualImport";

const pending: ManualImportOperationStatus = {
	operationId: "operation-a",
	state: "pending",
	reason: null,
	selectedFileCount: 2,
	verifiedFileCount: 0,
	canConsiderNewAttempt: false,
};
const clients: QueryClient[] = [];
afterEach(() => {
	cleanup();
	clients.splice(0).forEach((client) => {
		client.clear();
	});
	vi.unstubAllGlobals();
});
const response = (body: unknown) =>
	new Response(JSON.stringify(body), {
		status: 200,
		headers: { "content-type": "application/json" },
	});
function show(initial: Parameters<typeof useManualImportProgressQuery>[0]) {
	const client = new QueryClient({ defaultOptions: { queries: { retry: false } } });
	clients.push(client);
	return renderHook((props) => useManualImportProgressQuery(props), {
		initialProps: initial,
		wrapper: ({ children }: { children: ReactNode }) => (
			<QueryClientProvider client={client}>{children}</QueryClientProvider>
		),
	});
}

describe("Manual Import current attempt evidence recovery", () => {
	// Catches a parser/query change accepting a command acknowledgement as per-file completion.
	it("rejects contradictory terminal counts and explicitly recovers factual partial progress with GET only", async () => {
		const requests: Array<{ url: string; method: string }> = [];
		let body: unknown = { ...pending, state: "completed", verifiedFileCount: 0 };
		vi.stubGlobal(
			"fetch",
			vi.fn(async (url: string, options?: RequestInit) => {
				requests.push({ url, method: options?.method ?? "GET" });
				return response(body);
			}),
		);
		const view = show({ ownerId: "owner-a", idempotencyKey: "retained:attempt-a", enabled: true });
		await waitFor(() => expect(view.result.current.isError).toBe(true));
		expect(view.result.current.data).toBeUndefined();
		expect(requests).toEqual([
			{ url: "/api/manual-import/operations?idempotencyKey=retained%3Aattempt-a", method: "GET" },
		]);
		body = { ...pending, state: "partial", verifiedFileCount: 1, canConsiderNewAttempt: true };
		await act(async () => {
			await view.result.current.refetch();
		});
		await waitFor(() => expect(view.result.current.isSuccess).toBe(true));
		expect(view.result.current.data).toEqual({
			operationId: "operation-a",
			state: "partial",
			reason: null,
			selectedFileCount: 2,
			verifiedFileCount: 1,
			canConsiderNewAttempt: true,
		});
		expect(view.result.current.isError).toBe(false);
		expect(requests).toEqual(
			Array(2).fill({
				url: "/api/manual-import/operations?idempotencyKey=retained%3Aattempt-a",
				method: "GET",
			}),
		);
	});

	// Catches stale query completion crossing an owner/key transition and claiming another operation's facts.
	it("does not expose a late old-owner response in a newly selected attempt scope", async () => {
		let release!: () => void;
		const held = new Promise<void>((resolve) => {
			release = resolve;
		});
		const requests: string[] = [];
		let oldRead: Promise<Response> | undefined;
		vi.stubGlobal(
			"fetch",
			vi.fn((url: string) => {
				requests.push(url);
				if (url.includes("attempt-a")) {
					oldRead = held.then(() => response(pending));
					return oldRead;
				}
				return Promise.resolve(
					response({
						...pending,
						operationId: "operation-b",
						state: "unknown",
						reason: "evidence-unavailable",
					}),
				);
			}),
		);
		const view = show({ ownerId: "owner-a", idempotencyKey: "attempt-a", enabled: true });
		try {
			await waitFor(() => expect(requests).toHaveLength(1));
			view.rerender({ ownerId: "owner-b", idempotencyKey: "attempt-b", enabled: false });
			await act(async () => {
				release();
				await oldRead;
			});
			expect(view.result.current.data).toBeUndefined();
			expect(requests).toHaveLength(1);
			view.rerender({ ownerId: "owner-b", idempotencyKey: "attempt-b", enabled: true });
			await waitFor(() => expect(view.result.current.data?.operationId).toBe("operation-b"));
			expect(view.result.current.data).toMatchObject({
				state: "unknown",
				verifiedFileCount: 0,
				canConsiderNewAttempt: false,
			});
			expect(requests).toEqual([
				"/api/manual-import/operations?idempotencyKey=attempt-a",
				"/api/manual-import/operations?idempotencyKey=attempt-b",
			]);
		} finally {
			release();
			await oldRead;
		}
	});
});
