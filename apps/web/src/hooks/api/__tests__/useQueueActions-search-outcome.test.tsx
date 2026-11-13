import type { MultiInstanceQueueResponse, QueueItem } from "@arr/shared";
import { QueryClient, QueryClientProvider } from "@tanstack/react-query";
import { act, renderHook, waitFor } from "@testing-library/react";
import type { ReactNode } from "react";
import { afterEach, describe, expect, it, vi } from "vitest";
import { fetchMultiInstanceQueue, performQueueAction } from "../../../lib/api-client/dashboard";
import { QUEUE_QUERY_KEY } from "../../../lib/query-keys";
import { useQueueActions } from "../useQueueActions";

afterEach(() => vi.unstubAllGlobals());
const item = (service: QueueItem["service"], extra = {}): QueueItem => ({
	id: 11,
	instanceId: service,
	instanceName: "Synthetic",
	service,
	...extra,
});
function show(
	items: QueueItem[],
	respond: (body: Record<string, unknown>) => Response | Promise<Response>,
) {
	const client = new QueryClient({
		defaultOptions: {
			mutations: { retry: false, gcTime: Infinity },
			queries: { gcTime: Infinity },
		},
	});
	client.setQueryData<MultiInstanceQueueResponse>(QUEUE_QUERY_KEY, {
		instances: items.map((value) => ({
			instanceId: value.instanceId,
			instanceName: value.instanceName,
			service: value.service,
			data: [value],
		})),
		aggregated: items,
		totalCount: items.length,
	});
	const bodies: Array<Record<string, unknown>> = [];
	vi.stubGlobal("fetch", async (_url: string, options: RequestInit) => {
		const body = JSON.parse(String(options.body));
		bodies.push(body);
		return respond(body);
	});
	const hook = renderHook(() => useQueueActions(), {
		wrapper: ({ children }: { children: ReactNode }) => (
			<QueryClientProvider client={client}>{children}</QueryClientProvider>
		),
	});
	return { ...hook, client, bodies };
}
const result = (search: "submitted" | "unconfirmed") =>
	Response.json({ removal: "completed", search });
describe("queue search outcomes through real API client and action hook", () => {
	it.each(["delete", "retry"] as const)(
		"keeps ordinary %s rows and provider status pending until acknowledgment",
		async (action) => {
			const selected = item("radarr", { movieId: 101, status: "Downloading" });
			let release!: () => void;
			const gate = new Promise<void>((resolve) => {
				release = resolve;
			});
			const view = show([selected], async () => {
				await gate;
				return new Response(null, { status: 204 });
			});
			let operation!: Promise<void>;
			act(() => {
				operation = view.result.current.executeAsync(action, [selected], { search: false });
			});
			await waitFor(() => expect(view.bodies).toHaveLength(1));
			const pending = view.client.getQueryData<MultiInstanceQueueResponse>(QUEUE_QUERY_KEY);
			expect(pending?.totalCount).toBe(1);
			expect(pending?.aggregated).toEqual([selected]);
			await act(async () => {
				release();
				await operation;
			});
			expect(
				view.client.getQueryData<MultiInstanceQueueResponse>(QUEUE_QUERY_KEY)?.totalCount,
			).toBe(action === "delete" ? 0 : 1);
			if (action === "retry")
				expect(
					view.client.getQueryData<MultiInstanceQueueResponse>(QUEUE_QUERY_KEY)?.aggregated,
				).toEqual([selected]);
			expect(view.result.current.searchWarning).toBeNull();
			expect(view.bodies).toHaveLength(1);
			view.unmount();
			view.client.clear();
		},
	);
	it.each([false, true])(
		"preserves newer independent queue data after deferred search settlement (mixed=%s)",
		async (mixed) => {
			const selected = item("radarr", { movieId: 101 });
			const unrelated = item("sonarr", { id: 12, seriesId: 3 });
			const failed = item("lidarr", { id: 13, albumId: 4 });
			const unverified = item("readarr", { id: 14, bookId: 5 });
			let release!: () => void;
			const gate = new Promise<void>((resolve) => {
				release = resolve;
			});
			const selections = mixed ? [selected, failed, unverified] : [selected];
			const view = show(
				[selected, unrelated, ...(mixed ? [failed, unverified] : [])],
				async (body) => {
					await gate;
					if (body.instanceId === "lidarr")
						return Response.json({ message: "Synthetic refusal" }, { status: 500 });
					if (body.instanceId === "readarr") return Response.json({ search: "submitted" });
					return result("unconfirmed");
				},
			);
			let action!: Promise<unknown>;
			act(() => {
				action = view.result.current
					.executeAsync("delete", selections, { search: true })
					.catch((error: unknown) => error);
			});
			await waitFor(() => expect(view.bodies).toHaveLength(selections.length));
			const pendingCount =
				view.client.getQueryData<MultiInstanceQueueResponse>(QUEUE_QUERY_KEY)?.totalCount;
			const added = item("sonarr", { id: 15, status: "Independent retry finished" });
			const currentRows = [
				selected,
				added,
				...(mixed
					? [
							{ ...failed, status: "Latest failed target" },
							{ ...unverified, status: "Latest unverified target" },
						]
					: []),
			];
			const latest: MultiInstanceQueueResponse = {
				instances: currentRows.map((value) => ({
					instanceId: value.instanceId,
					instanceName: "Latest metadata",
					service: value.service,
					data: [value],
				})),
				aggregated: currentRows,
				totalCount: currentRows.length,
			};
			act(() => {
				view.client.setQueryData(QUEUE_QUERY_KEY, latest);
			});
			await act(async () => {
				release();
				await action;
			});
			vi.stubGlobal("fetch", async () =>
				Response.json({ message: "Synthetic readback failure" }, { status: 500 }),
			);
			await expect(
				view.client.fetchQuery({
					queryKey: QUEUE_QUERY_KEY,
					queryFn: fetchMultiInstanceQueue,
					retry: false,
				}),
			).rejects.toThrow();
			const expectedRows = currentRows.filter((value) => value !== selected);
			expect(view.client.getQueryData(QUEUE_QUERY_KEY)).toEqual({
				...latest,
				instances: latest.instances.map((instance) => ({
					...instance,
					data: instance.data.filter((value) => value !== selected),
				})),
				aggregated: expectedRows,
				totalCount: expectedRows.length,
			});
			expect(pendingCount).toBe(mixed ? 4 : 2);
			expect(view.result.current.searchWarning).toBe(mixed ? "unverified" : "unconfirmed");
			expect(view.bodies).toHaveLength(selections.length);
			view.unmount();
			view.client.clear();
		},
	);
	it.each(["malformed", "truncated", "empty", "read-rejected", "non-json"])(
		"retains unverified rows for unreadable %s200 without destructive replay",
		async (mode) => {
			const selected = item("radarr", { movieId: 101 });
			const view = show([selected], () => {
				const response = new Response(
					mode === "empty" ? "" : mode === "truncated" ? '{"removal":' : "not-json",
					{
						status: 200,
						headers: { "content-type": mode === "non-json" ? "text/plain" : "application/json" },
					},
				);
				if (mode === "read-rejected")
					response.json = async () => {
						throw new Error("Synthetic private body failure");
					};
				return response;
			});
			await act(async () => {
				await view.result.current.executeAsync("delete", [selected], { search: true });
			});
			expect(
				view.client.getQueryData<MultiInstanceQueueResponse>(QUEUE_QUERY_KEY)?.aggregated,
			).toEqual([selected]);
			expect(view.result.current.searchWarning).toBe("unverified");
			view.rerender();
			expect(view.result.current.searchWarning).toBe("unverified");
			expect(view.client.getQueryState(QUEUE_QUERY_KEY)?.isInvalidated).toBe(true);
			expect(view.bodies).toHaveLength(1);
			view.unmount();
			view.client.clear();
		},
	);
	it.each([["submitted"], ["unconfirmed"]] as const)(
		"validates structured %s response",
		async (search) => {
			vi.stubGlobal("fetch", async () => result(search));
			expect(
				await performQueueAction({
					instanceId: "radarr",
					service: "radarr",
					itemId: 11,
					action: "delete",
					search: true,
					removeFromClient: true,
					blocklist: true,
					changeCategory: false,
					searchPayload: { movieId: 101 },
				}),
			).toEqual({ removal: "completed", search });
		},
	);
	it("legacy204 proves removal only and malformed200 proves neither step", async () => {
		vi.stubGlobal("fetch", async () => new Response(null, { status: 204 }));
		const payload = {
			instanceId: "radarr",
			service: "radarr",
			itemId: 11,
			action: "delete",
			search: true,
			removeFromClient: true,
			blocklist: true,
			changeCategory: false,
		} as const;
		expect(await performQueueAction(payload)).toEqual({
			removal: "completed",
			search: "unconfirmed",
		});
		vi.stubGlobal("fetch", async () => Response.json({ search: "submitted" }));
		expect(await performQueueAction(payload)).toEqual({
			removal: "unverified",
			search: "unconfirmed",
		});
	});
	it.each([
		[item("sonarr", { episodeId: 2, seriesId: 3 }), { episodeIds: [2], seriesId: 3 }],
		[item("radarr", { movieId: 101 }), { movieId: 101 }],
		[item("lidarr", { albumId: 9, artistId: 7 }), { albumId: 9 }],
		[item("readarr", { bookId: 8, authorId: 6 }), { bookId: 8 }],
	])("forwards normalized %s search targets", async (value, expected) => {
		const view = show([value as QueueItem], () => result("submitted"));
		await act(async () => {
			await view.result.current.executeAsync("delete", [value as QueueItem], { search: true });
		});
		expect(view.bodies[0]?.searchPayload).toEqual(expected);
		view.unmount();
		view.client.clear();
	});
	it("retains each proven removal and its warning when another removal rejects", async () => {
		const items = [
			item("radarr", { movieId: 101 }),
			{ ...item("radarr", { movieId: 102 }), instanceId: "radarr-other" },
			item("sonarr", { seriesId: 103 }),
		];
		const view = show(items, (body) =>
			body.instanceId === "sonarr"
				? Response.json({ message: "Synthetic deletion refused" }, { status: 500 })
				: result(body.instanceId === "radarr" ? "unconfirmed" : "submitted"),
		);
		await act(async () => {
			await expect(
				view.result.current.executeAsync("delete", items, { search: true }),
			).rejects.toThrow();
		});
		expect(
			view.client.getQueryData<MultiInstanceQueueResponse>(QUEUE_QUERY_KEY)?.aggregated,
		).toEqual([items[2]]);
		expect(view.client.getQueryData<MultiInstanceQueueResponse>(QUEUE_QUERY_KEY)?.totalCount).toBe(
			1,
		);
		expect(view.result.current.searchWarning).toBe("unconfirmed");
		view.unmount();
		view.client.clear();
	});
	it.each(["legacy", "malformed"])(
		"keeps actionable %s uncertainty and invalidates the queue",
		async (mode) => {
			const selected = item("radarr", { movieId: 101 });
			const view = show([selected], () =>
				mode === "legacy"
					? new Response(null, { status: 204 })
					: Response.json({ search: "submitted" }),
			);
			await act(async () => {
				await view.result.current.executeAsync("delete", [selected], { search: true });
			});
			expect(view.result.current.searchWarning).toBe(
				mode === "legacy" ? "unconfirmed" : "unverified",
			);
			expect(
				view.client.getQueryData<MultiInstanceQueueResponse>(QUEUE_QUERY_KEY)?.totalCount,
			).toBe(mode === "legacy" ? 0 : 1);
			expect(view.client.getQueryState(QUEUE_QUERY_KEY)?.isInvalidated).toBe(true);
			view.unmount();
			view.client.clear();
		},
	);
	it.each([
		[item("sonarr", { seriesId: 3 }), { seriesId: 3 }],
		[item("lidarr", { artistId: 7 }), { artistId: 7 }],
		[item("readarr", { authorId: 6 }), { authorId: 6 }],
	])(
		"uses only the normalized broader target when the narrower target is absent",
		async (value, expected) => {
			const view = show([value as QueueItem], () => result("submitted"));
			await act(async () => {
				await view.result.current.executeAsync("delete", [value as QueueItem], { search: true });
			});
			expect(view.bodies[0]?.searchPayload).toEqual(expected);
			view.unmount();
			view.client.clear();
		},
	);
});
