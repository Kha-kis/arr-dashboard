import { QueryClient, QueryClientProvider } from "@tanstack/react-query";
import { act, cleanup, renderHook, waitFor } from "@testing-library/react";
import type { ReactNode } from "react";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import * as api from "../../../lib/api-client/qui";
import { quiKeys } from "../../../lib/query-keys";
import {
	completeQuiTagObservation,
	type QuiTagFences,
	quiTagTargetKey,
} from "../../../lib/qui-tag-fence";
import { useQuiTagMutationFence, useQuiTorrentAction } from "../useQui";

vi.mock("../../../lib/api-client/qui");
const clients: QueryClient[] = [];
const target = { quiInstanceId: "qui-1", qbitInstanceId: 7, hash: "a".repeat(40) };
const action = { ...target, action: "setTags", payload: { tags: "seed,A" } } as const;
const acknowledged = { status: "success", logRowCount: 1 } as const;
function mount(
	client = new QueryClient({
		defaultOptions: {
			queries: { retry: false, gcTime: 0 },
			mutations: { retry: false, gcTime: 0 },
		},
	}),
) {
	if (!clients.includes(client)) clients.push(client);
	const wrapper = ({ children }: { children: ReactNode }) => (
		<QueryClientProvider client={client}>{children}</QueryClientProvider>
	);
	return {
		client,
		...renderHook(
			() => ({
				first: useQuiTorrentAction(),
				second: useQuiTorrentAction(),
				fence: useQuiTagMutationFence(target),
			}),
			{ wrapper },
		),
	};
}
beforeEach(() => {
	vi.resetAllMocks();
	vi.mocked(api.postQuiTorrentAction).mockResolvedValue(acknowledged);
	vi.stubGlobal("fetch", vi.fn().mockRejectedValue(new Error("Network forbidden in fixture")));
});
afterEach(() => {
	cleanup();
	for (const client of clients.splice(0)) client.clear();
	expect(fetch).not.toHaveBeenCalled();
	vi.useRealTimers();
	vi.unstubAllGlobals();
});

describe("Shared tag attempt lifetime through real mutation hooks", () => {
	it("supports tag writes and distinct fenced attempts when secure-context randomUUID is unavailable", async () => {
		const getRandomValues = crypto.getRandomValues.bind(crypto);
		vi.stubGlobal("crypto", { getRandomValues });
		const mounted = mount();
		await act(async () => {
			await expect(mounted.result.current.first.mutateAsync(action)).resolves.toEqual(acknowledged);
		});
		const first = mounted.client.getQueryData<QuiTagFences>(quiKeys.tagFences)![
			quiTagTargetKey(target)
		]!;
		expect(first.status).toBe("acknowledged");
		expect(first.attemptId).toBeTruthy();
		await act(async () => {
			await expect(mounted.result.current.second.mutateAsync(action)).rejects.toThrow(
				/refresh torrent data/i,
			);
		});
		expect(api.postQuiTorrentAction).toHaveBeenCalledTimes(1);
		act(() => completeQuiTagObservation(mounted.client, quiTagTargetKey(target), first));
		await act(async () => {
			await mounted.result.current.second.mutateAsync(action);
		});
		const second = mounted.client.getQueryData<QuiTagFences>(quiKeys.tagFences)![
			quiTagTargetKey(target)
		]!;
		expect(second.status).toBe("acknowledged");
		expect(second.attemptId).not.toBe(first.attemptId);
		expect(api.postQuiTorrentAction).toHaveBeenCalledTimes(2);
		act(() => completeQuiTagObservation(mounted.client, quiTagTargetKey(target), second));
		expect(mounted.client.getQueryData(quiKeys.tagFences)).toEqual({});
	});

	it("rejects another observer's same-target replacement without dispatching or releasing its pending fence", async () => {
		let resolve!: (value: typeof acknowledged) => void;
		vi.mocked(api.postQuiTorrentAction).mockReturnValueOnce(
			new Promise((done) => {
				resolve = done;
			}),
		);
		const mounted = mount();
		act(() => mounted.result.current.first.mutate(action));
		await waitFor(() => expect(mounted.result.current.fence?.status).toBe("pending"));
		try {
			await act(async () => {
				await expect(
					mounted.result.current.second.mutateAsync({ ...action, payload: { tags: "seed,B" } }),
				).rejects.toThrow(/refresh torrent data/i);
			});
			expect(api.postQuiTorrentAction).toHaveBeenCalledTimes(1);
			expect(mounted.result.current.fence?.status).toBe("pending");
		} finally {
			await act(async () => resolve(acknowledged));
		}
		await waitFor(() => expect(mounted.result.current.fence?.status).toBe("acknowledged"));
		await act(async () => {
			await expect(mounted.result.current.second.mutateAsync(action)).rejects.toThrow(
				/refresh torrent data/i,
			);
		});
		expect(api.postQuiTorrentAction).toHaveBeenCalledTimes(1);
	});

	it("retains an unconfirmed attempt after every observer unmounts and ordinary cache GC time passes", async () => {
		let reject!: (reason: Error) => void;
		vi.mocked(api.postQuiTorrentAction).mockReturnValueOnce(
			new Promise((_, fail) => {
				reject = fail;
			}),
		);
		const mounted = mount();
		act(() => mounted.result.current.first.mutate(action));
		await waitFor(() => expect(mounted.result.current.fence?.status).toBe("pending"));
		mounted.unmount();
		await act(async () => reject(new Error("Synthetic response lost")));
		await waitFor(() => expect(mounted.client.isMutating()).toBe(0));
		vi.useFakeTimers();
		await act(async () => {
			await vi.advanceTimersByTimeAsync(600_000);
		});
		vi.useRealTimers();
		const reopened = mount(mounted.client);
		expect(reopened.result.current.fence?.status).toBe("unconfirmed");
		await act(async () => {
			await reopened.client.invalidateQueries({ queryKey: quiKeys.all });
		});
		expect(reopened.result.current.fence?.status).toBe("unconfirmed");
		expect(api.postQuiTorrentAction).toHaveBeenCalledTimes(1);
	});

	it.each([
		{ quiInstanceId: "qui-1", qbitInstanceId: 8 },
		{ quiInstanceId: "qui-2", qbitInstanceId: 7 },
	])(
		"keeps a same-hash $quiInstanceId/$qbitInstanceId target independent and removes resolved entries",
		async (other) => {
			const mounted = mount();
			await act(async () => {
				await mounted.result.current.first.mutateAsync(action);
			});
			await act(async () => {
				await mounted.result.current.second.mutateAsync({ ...action, ...other });
			});
			expect(api.postQuiTorrentAction).toHaveBeenCalledTimes(2);
			const otherKey = quiTagTargetKey({ ...target, ...other });
			const fences = mounted.client.getQueryData<QuiTagFences>(quiKeys.tagFences)!;
			expect(Object.keys(fences)).toHaveLength(2);
			act(() => completeQuiTagObservation(mounted.client, otherKey, fences[otherKey]!));
			expect(
				mounted.client.getQueryData<QuiTagFences>(quiKeys.tagFences)?.[otherKey],
			).toBeUndefined();
			expect(
				mounted.client.getQueryData<QuiTagFences>(quiKeys.tagFences)?.[quiTagTargetKey(target)]
					?.status,
			).toBe("acknowledged");
			act(() =>
				completeQuiTagObservation(
					mounted.client,
					quiTagTargetKey(target),
					fences[quiTagTargetKey(target)]!,
				),
			);
			expect(mounted.client.getQueryData(quiKeys.tagFences)).toEqual({});
		},
	);

	it("refuses an old attempt's late read and a read started before the current attempt settled", async () => {
		const mounted = mount();
		await act(async () => {
			await mounted.result.current.first.mutateAsync(action);
		});
		const oldFence = mounted.client.getQueryData<QuiTagFences>(quiKeys.tagFences)![
			quiTagTargetKey(target)
		]!;
		act(() => completeQuiTagObservation(mounted.client, quiTagTargetKey(target), oldFence));
		let resolve!: (value: typeof acknowledged) => void;
		vi.mocked(api.postQuiTorrentAction).mockReturnValueOnce(
			new Promise((done) => {
				resolve = done;
			}),
		);
		act(() => mounted.result.current.first.mutate(action));
		await waitFor(() => expect(mounted.result.current.fence?.status).toBe("pending"));
		const beforeSettlement = mounted.result.current.fence!;
		try {
			act(() => completeQuiTagObservation(mounted.client, quiTagTargetKey(target), oldFence));
			expect(mounted.result.current.fence?.status).toBe("pending");
		} finally {
			await act(async () => resolve(acknowledged));
		}
		await waitFor(() => expect(mounted.result.current.fence?.status).toBe("acknowledged"));
		act(() => completeQuiTagObservation(mounted.client, quiTagTargetKey(target), beforeSettlement));
		expect(mounted.result.current.fence?.status).toBe("acknowledged");
		expect(mounted.result.current.fence?.attemptId).not.toBe(oldFence.attemptId);
	});
});
