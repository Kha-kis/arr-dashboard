import { QueryClient, QueryClientProvider } from "@tanstack/react-query";
import { act, renderHook, waitFor } from "@testing-library/react";
import type { ReactNode } from "react";
import { toast } from "sonner";
import { beforeEach, describe, expect, it, vi } from "vitest";
import { bulkScoreKeys, qualityProfileKeys } from "../../../lib/query-keys";

const apiMocks = vi.hoisted(() => ({
	updateQualityProfileScores: vi.fn(),
}));

vi.mock("../../../lib/api-client/trash-guides", async (importOriginal) => {
	const actual = await importOriginal<typeof import("../../../lib/api-client/trash-guides")>();
	return {
		...actual,
		updateQualityProfileScores: apiMocks.updateQualityProfileScores,
	};
});

vi.mock("sonner", () => ({
	toast: {
		error: vi.fn(),
		success: vi.fn(),
		warning: vi.fn(),
	},
}));

import { useBulkUpdateScores } from "../useQualityProfileScores";

function createWrapper(queryClient: QueryClient) {
	return function Wrapper({ children }: { children: ReactNode }) {
		return <QueryClientProvider client={queryClient}>{children}</QueryClientProvider>;
	};
}

function createDeferred<T>() {
	let resolve!: (value: T) => void;
	let reject!: (reason?: unknown) => void;
	const promise = new Promise<T>((resolvePromise, rejectPromise) => {
		resolve = resolvePromise;
		reject = rejectPromise;
	});
	return { promise, reject, resolve };
}

const successfulResponse = {
	success: true,
	message: "Scores updated",
	updatedCount: 1,
};

describe("useBulkUpdateScores", () => {
	beforeEach(() => {
		vi.clearAllMocks();
	});

	it("waits for each profile update before starting the next one", async () => {
		const firstUpdate = createDeferred<typeof successfulResponse>();
		const secondUpdate = createDeferred<typeof successfulResponse>();
		apiMocks.updateQualityProfileScores
			.mockReturnValueOnce(firstUpdate.promise)
			.mockReturnValueOnce(secondUpdate.promise);
		const queryClient = new QueryClient({
			defaultOptions: { mutations: { retry: false }, queries: { retry: false } },
		});
		const { result } = renderHook(() => useBulkUpdateScores(), {
			wrapper: createWrapper(queryClient),
		});

		let mutationPromise!: ReturnType<typeof result.current.mutateAsync>;
		act(() => {
			mutationPromise = result.current.mutateAsync([
				{
					entryKey: "instance-1-101",
					instanceId: "instance-1",
					profileId: 101,
					changes: [{ cfTrashId: "cf-10", score: -10000 }],
				},
				{
					entryKey: "instance-1-202",
					instanceId: "instance-1",
					profileId: 202,
					changes: [{ cfTrashId: "cf-20", score: 125 }],
				},
			]);
		});

		await waitFor(() => expect(apiMocks.updateQualityProfileScores).toHaveBeenCalledTimes(1));
		expect(apiMocks.updateQualityProfileScores).toHaveBeenNthCalledWith(1, "instance-1", 101, {
			scoreUpdates: [{ customFormatId: 10, score: -10000 }],
		});

		act(() => firstUpdate.resolve(successfulResponse));
		await waitFor(() => expect(apiMocks.updateQualityProfileScores).toHaveBeenCalledTimes(2));

		act(() => secondUpdate.resolve(successfulResponse));
		await act(async () => {
			await mutationPromise;
		});
		queryClient.clear();
	});

	it("reports complete success as saved quality profiles", async () => {
		apiMocks.updateQualityProfileScores.mockResolvedValue(successfulResponse);
		const queryClient = new QueryClient({
			defaultOptions: { mutations: { retry: false }, queries: { retry: false } },
		});
		const { result } = renderHook(() => useBulkUpdateScores(), {
			wrapper: createWrapper(queryClient),
		});

		await act(async () => {
			await result.current.mutateAsync([
				{
					entryKey: "instance-1-101",
					instanceId: "instance-1",
					profileId: 101,
					changes: [{ cfTrashId: "cf-10", score: -10000 }],
				},
			]);
		});

		expect(toast.success).toHaveBeenCalledWith("Saved scores for 1 quality profile");
		expect(toast.warning).not.toHaveBeenCalled();
		expect(toast.error).not.toHaveBeenCalled();
		queryClient.clear();
	});

	it("returns typed partial results and refreshes every successful profile", async () => {
		apiMocks.updateQualityProfileScores
			.mockResolvedValueOnce(successfulResponse)
			.mockRejectedValueOnce(new Error("Profile 202 is locked"));
		const queryClient = new QueryClient({
			defaultOptions: { mutations: { retry: false }, queries: { retry: false } },
		});
		const invalidateQueries = vi.spyOn(queryClient, "invalidateQueries");
		const { result } = renderHook(() => useBulkUpdateScores(), {
			wrapper: createWrapper(queryClient),
		});

		let caught: unknown;
		await act(async () => {
			caught = await result.current
				.mutateAsync([
					{
						entryKey: "instance-1-101",
						instanceId: "instance-1",
						profileId: 101,
						changes: [{ cfTrashId: "cf-10", score: -10000 }],
					},
					{
						entryKey: "instance-1-202",
						instanceId: "instance-1",
						profileId: 202,
						changes: [{ cfTrashId: "cf-20", score: 125 }],
					},
				])
				.catch((error: unknown) => error);
		});

		expect(caught).toMatchObject({
			name: "BulkUpdateScoresError",
			result: {
				totalProfiles: 2,
				successCount: 1,
				failureCount: 1,
				results: [
					{
						entryKey: "instance-1-101",
						instanceId: "instance-1",
						profileId: 101,
						success: true,
					},
					{
						entryKey: "instance-1-202",
						instanceId: "instance-1",
						profileId: 202,
						success: false,
					},
				],
			},
		});
		await waitFor(() =>
			expect(invalidateQueries).toHaveBeenCalledWith({ queryKey: bulkScoreKeys.all }),
		);
		expect(invalidateQueries).toHaveBeenCalledWith({
			queryKey: qualityProfileKeys.overrides("instance-1", 101),
		});
		expect(invalidateQueries).not.toHaveBeenCalledWith({
			queryKey: qualityProfileKeys.overrides("instance-1", 202),
		});
		expect(toast.warning).toHaveBeenCalledWith("Saved scores for 1 of 2 quality profiles", {
			description: "1 quality profile failed. Failed edits were kept for retry.",
		});
		expect(toast.error).not.toHaveBeenCalled();
		queryClient.clear();
	});

	it("reports complete failure without implying that any scores were saved", async () => {
		apiMocks.updateQualityProfileScores.mockRejectedValue(new Error("Profile 101 is locked"));
		const queryClient = new QueryClient({
			defaultOptions: { mutations: { retry: false }, queries: { retry: false } },
		});
		const { result } = renderHook(() => useBulkUpdateScores(), {
			wrapper: createWrapper(queryClient),
		});

		await act(async () => {
			await result.current
				.mutateAsync([
					{
						entryKey: "instance-1-101",
						instanceId: "instance-1",
						profileId: 101,
						changes: [{ cfTrashId: "cf-10", score: -10000 }],
					},
				])
				.catch(() => undefined);
		});

		expect(toast.error).toHaveBeenCalledWith("No quality profile scores were saved", {
			description: "Failed to update 1 quality profile(s): Profile 101 is locked",
		});
		expect(toast.success).not.toHaveBeenCalled();
		expect(toast.warning).not.toHaveBeenCalled();
		queryClient.clear();
	});

	it("rejects an invalid Custom Format ID before starting any profile update", async () => {
		apiMocks.updateQualityProfileScores.mockResolvedValue(successfulResponse);
		const queryClient = new QueryClient({
			defaultOptions: { mutations: { retry: false }, queries: { retry: false } },
		});
		const { result } = renderHook(() => useBulkUpdateScores(), {
			wrapper: createWrapper(queryClient),
		});

		let caught: unknown;
		await act(async () => {
			caught = await result.current
				.mutateAsync([
					{
						entryKey: "instance-1-101",
						instanceId: "instance-1",
						profileId: 101,
						changes: [{ cfTrashId: "cf-10", score: -10000 }],
					},
					{
						entryKey: "instance-1-202",
						instanceId: "instance-1",
						profileId: 202,
						changes: [{ cfTrashId: "not-a-cf-id", score: 125 }],
					},
				])
				.catch((error: unknown) => error);
		});

		expect(apiMocks.updateQualityProfileScores).not.toHaveBeenCalled();
		expect(caught).toMatchObject({
			name: "BulkUpdateScoresError",
			result: {
				totalProfiles: 2,
				successCount: 0,
				failureCount: 2,
				results: [
					{ entryKey: "instance-1-101", success: false },
					{
						entryKey: "instance-1-202",
						success: false,
						error: expect.objectContaining({
							message: expect.stringContaining('Invalid Custom Format ID "not-a-cf-id"'),
						}),
					},
				],
			},
		});
		queryClient.clear();
	});
});
