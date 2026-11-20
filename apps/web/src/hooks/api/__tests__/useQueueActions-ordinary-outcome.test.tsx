import type { MultiInstanceQueueResponse, QueueItem } from "@arr/shared";
import { QueryClient, QueryClientProvider } from "@tanstack/react-query";
import { act, renderHook, waitFor } from "@testing-library/react";
import type { ReactNode } from "react";
import { afterEach, describe, expect, it, vi } from "vitest";
import { useDashboardQueue } from "../../../features/dashboard/hooks/useDashboardQueue";
import { fetchMultiInstanceQueue } from "../../../lib/api-client/dashboard";
import { authKeys, QUEUE_QUERY_KEY } from "../../../lib/query-keys";

const row = (instanceId: string, id = 11, extra = {}): QueueItem => ({
	instanceId,
	id,
	instanceName: "Synthetic",
	service: "radarr",
	status: "Queued",
	...extra,
});
const queue = (rows: QueueItem[]): MultiInstanceQueueResponse => ({
	instances: [...new Set(rows.map((value) => value.instanceId))].map((instanceId) => ({
		instanceId,
		instanceName: "Synthetic",
		service: "radarr",
		data: rows.filter((value) => value.instanceId === instanceId),
	})),
	aggregated: rows,
	totalCount: rows.length,
});
function gate() {
	let resolve!: (value: Response) => void;
	const promise = new Promise<Response>((done) => {
		resolve = done;
	});
	return { promise, resolve };
}
function show(rows: QueueItem[], transport: (body: Record<string, unknown>) => Promise<Response>) {
	const client = new QueryClient({
		defaultOptions: {
			mutations: { retry: false, gcTime: Infinity },
			queries: { retry: false, gcTime: Infinity, staleTime: Infinity },
		},
	});
	client.setQueryData(authKeys.currentUser, { id: "owner", username: "Synthetic" });
	client.setQueryData(QUEUE_QUERY_KEY, queue(rows));
	const requests: Array<{ url: string; body: Record<string, unknown> }> = [],
		pending = new Set<Promise<Response>>();
	let readback: () => Promise<Response> = async () => Response.json(queue(rows));
	vi.stubGlobal("fetch", async (url: string, options?: RequestInit) => {
		if (url === "/auth/me") return Response.json({ id: "owner", username: "Synthetic" });
		if (!options?.body) return readback();
		const body = JSON.parse(String(options.body));
		requests.push({ url, body });
		const operation = transport(body);
		pending.add(operation);
		try {
			return await operation;
		} finally {
			pending.delete(operation);
		}
	});
	const view = renderHook(() => useDashboardQueue(), {
		wrapper: ({ children }: { children: ReactNode }) => (
			<QueryClientProvider client={client}>{children}</QueryClientProvider>
		),
	});
	return {
		...view,
		client,
		requests,
		pending,
		setReadback: (read: () => Promise<Response>) => {
			readback = read;
		},
		read: () =>
			client.fetchQuery({
				queryKey: QUEUE_QUERY_KEY,
				queryFn: fetchMultiInstanceQueue,
				staleTime: 0,
				retry: false,
			}),
		data: () => client.getQueryData<MultiInstanceQueueResponse>(QUEUE_QUERY_KEY),
		close: () => {
			view.unmount();
			client.clear();
		},
	};
}
afterEach(() => vi.unstubAllGlobals());
describe("ordinary queue outcomes at real Dashboard hook/client/cache boundary", () => {
	it("keeps refused bulk members last-known without inferring a partial success from their error body", async () => {
		const rows = [row("accepted"), row("bulk", 11), row("bulk", 12)];
		const view = show(rows, async (body) =>
			body.instanceId === "accepted"
				? new Response(null, { status: 204 })
				: Response.json({ message: "Synthetic bulk refusal", removedIds: [11] }, { status: 500 }),
		);
		try {
			await act(async () => {
				await expect(view.result.current.handleQueueRemove(rows)).rejects.toThrow(
					"Synthetic bulk refusal",
				);
			});
			expect(view.data()?.aggregated).toEqual([rows[1], rows[2]]);
			expect(view.data()?.totalCount).toBe(2);
			expect(view.requests).toHaveLength(2);
		} finally {
			view.close();
		}
	});
	it("retains every ordinary single and bulk target when successful200 is not a verified204 acknowledgment", async () => {
		const rows = [row("single"), row("bulk", 11), row("bulk", 12)],
			view = show(rows, async () => Response.json({ removal: "completed", search: "submitted" }));
		try {
			await act(async () => {
				await expect(view.result.current.handleQueueRemove(rows)).rejects.toThrow(
					"Request acknowledgment could not be verified.",
				);
			});
			expect(view.data()?.aggregated).toEqual(rows);
			expect(view.data()?.totalCount).toBe(3);
			expect(view.requests).toHaveLength(2);
		} finally {
			view.close();
		}
	});
	it("applies acknowledged deletion only to the matching service, instance and queue ID", async () => {
		const selected = row("first"),
			otherService = { ...row("first"), service: "sonarr" as const },
			otherInstance = row("other"),
			view = show(
				[selected, otherService, otherInstance],
				async () => new Response(null, { status: 204 }),
			);
		try {
			await act(async () => {
				await view.result.current.handleQueueRemove([selected]);
			});
			expect(view.data()?.aggregated).toEqual([otherService, otherInstance]);
			expect(view.data()?.totalCount).toBe(2);
		} finally {
			view.close();
		}
	});
	it.each(["delete", "retry"] as const)(
		"Q1 groups successful ordinary %s into exact single/bulk source targets",
		async (action) => {
			const rows = [row("first", 11), row("first", 12), row("second", 11)];
			const view = show(rows, async () => new Response(null, { status: 204 }));
			try {
				await act(async () => {
					if (action === "delete")
						await view.result.current.handleQueueRemove(rows, {
							removeFromClient: false,
							blocklist: true,
							changeCategory: true,
							search: false,
						});
					else await view.result.current.handleQueueRetry(rows);
				});
				const flags =
					action === "delete"
						? { removeFromClient: false, blocklist: true, changeCategory: true, search: false }
						: { removeFromClient: true, blocklist: false, changeCategory: false, search: false };
				expect(view.requests).toEqual([
					{
						url: "/api/dashboard/queue/bulk",
						body: { instanceId: "first", service: "radarr", ids: [11, 12], action, ...flags },
					},
					{
						url: "/api/dashboard/queue/action",
						body: { instanceId: "second", service: "radarr", itemId: 11, action, ...flags },
					},
				]);
				expect(view.result.current.queueActionsPending).toBe(false);
				expect(view.result.current.queueActionsError).toBeNull();
				expect(view.data()?.totalCount).toBe(action === "delete" ? 0 : 3);
				expect(view.pending.size).toBe(0);
			} finally {
				view.close();
			}
		},
	);
	it("Q2 releases a refused single action, reads current state, and explicitly retries only the remainder", async () => {
		const selected = row("first");
		let accepted = false;
		const view = show([selected], async () =>
			accepted
				? new Response(null, { status: 204 })
				: Response.json({ message: "Synthetic removal refused" }, { status: 500 }),
		);
		try {
			await act(async () => {
				await expect(view.result.current.handleQueueRemove([selected])).rejects.toThrow(
					"Synthetic removal refused",
				);
			});
			await waitFor(() =>
				expect(view.result.current.queueActionsError?.message).toBe("Synthetic removal refused"),
			);
			expect(view.result.current.queueActionsPending).toBe(false);
			expect(view.data()?.aggregated).toEqual([selected]);
			await view.read();
			accepted = true;
			await act(async () => {
				await view.result.current.handleQueueRemove(view.data()!.aggregated);
			});
			expect(view.requests).toHaveLength(2);
			expect(view.requests.map((value) => value.body.itemId)).toEqual([11, 11]);
			expect(view.data()?.totalCount).toBe(0);
			await waitFor(() => expect(view.result.current.queueActionsError).toBeNull());
			expect(view.pending.size).toBe(0);
		} finally {
			view.close();
		}
	});
	it("Q3 waits for every group and preserves acknowledged effects despite another group's refusal", async () => {
		const rows = [row("acknowledged"), row("refused"), row("deferred")],
			gates = new Map(rows.map((value) => [value.instanceId, gate()]));
		const view = show(rows, (body) => gates.get(String(body.instanceId))!.promise);
		let operation: Promise<unknown> = Promise.resolve(),
			settled = false;
		try {
			act(() => {
				operation = view.result.current
					.handleQueueRemove(rows)
					.catch((error) => error)
					.finally(() => {
						settled = true;
					});
			});
			await waitFor(() => expect(view.requests).toHaveLength(3));
			await act(async () => {
				gates.get("acknowledged")!.resolve(new Response(null, { status: 204 }));
				gates
					.get("refused")!
					.resolve(Response.json({ message: "Synthetic refusal" }, { status: 500 }));
				await Promise.all([gates.get("acknowledged")!.promise, gates.get("refused")!.promise]);
			});
			await waitFor(() =>
				expect(view.result.current.queueActionsPending).toBe(
					view.client.getMutationCache().getAll().at(-1)?.state.status === "pending",
				),
			);
			const early = {
				settled,
				pending: view.result.current.queueActionsPending,
				physicalPending: view.pending.size,
			};
			await act(async () => {
				gates.get("deferred")!.resolve(new Response(null, { status: 204 }));
				await operation;
				await Promise.all([...view.pending]);
			});
			expect.soft(early).toEqual({ settled: false, pending: true, physicalPending: 1 });
			expect.soft(view.data()?.aggregated).toEqual([rows[1]]);
			expect.soft(view.data()?.totalCount).toBe(1);
			expect(view.pending.size).toBe(0);
			await waitFor(() => expect(view.result.current.queueActionsPending).toBe(false));
		} finally {
			for (const value of gates.values()) value.resolve(new Response(null, { status: 204 }));
			await act(async () => {
				await operation;
				await Promise.allSettled([...view.pending]);
			});
			view.close();
		}
	});
	it("Q4 preserves an independent newer queue write when a deferred failure and subsequent GET fail", async () => {
		const selected = row("selected"),
			removedElsewhere = row("removed-elsewhere"),
			held = gate();
		const view = show([selected, removedElsewhere], () => held.promise);
		let operation: Promise<unknown> = Promise.resolve();
		try {
			act(() => {
				operation = view.result.current.handleQueueRemove([selected]).catch((error) => error);
			});
			await waitFor(() => expect(view.requests).toHaveLength(1));
			const latest = queue([
				{ ...selected, status: "Independent latest status" },
				row("new", 15, { status: "Independent addition" }),
			]);
			latest.instances[0]!.instanceName = "Latest metadata";
			act(() => {
				view.client.setQueryData(QUEUE_QUERY_KEY, latest);
			});
			await act(async () => {
				held.resolve(Response.json({ message: "Synthetic refusal" }, { status: 500 }));
				await operation;
			});
			view.setReadback(async () =>
				Response.json({ message: "Synthetic readback failure" }, { status: 500 }),
			);
			await expect(view.read()).rejects.toThrow();
			expect(view.data()).toEqual(latest);
			expect(view.pending.size).toBe(0);
		} finally {
			held.resolve(new Response(null, { status: 204 }));
			await act(async () => {
				await operation;
				await Promise.allSettled([...view.pending]);
			});
			view.close();
		}
	});
	it("Q5 transport uncertainty is not replayed and recovery uses fresh server data", async () => {
		const selected = row("first"),
			view = show([selected], async () => {
				throw new TypeError("Synthetic delivery uncertain");
			});
		try {
			await act(async () => {
				await expect(view.result.current.handleQueueRemove([selected])).rejects.toThrow(
					/Cannot connect/,
				);
			});
			await waitFor(() =>
				expect(view.result.current.queueActionsError?.message).toMatch(/Cannot connect/),
			);
			expect(view.result.current.queueActionsPending).toBe(false);
			view.setReadback(async () =>
				Response.json({ message: "Synthetic readback failure" }, { status: 500 }),
			);
			await expect(view.read()).rejects.toThrow();
			expect(view.data()?.aggregated).toEqual([selected]);
			view.setReadback(async () => Response.json(queue([])));
			await view.read();
			expect(view.data()?.totalCount).toBe(0);
			expect(view.requests).toHaveLength(1);
			expect(view.pending.size).toBe(0);
		} finally {
			view.close();
		}
	});
});
