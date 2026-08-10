import { QueryClient, QueryClientProvider } from "@tanstack/react-query";
import { act, fireEvent, render, screen, waitFor } from "@testing-library/react";
import type { ReactNode } from "react";
import { beforeEach, describe, expect, it, vi } from "vitest";

const hookMocks = vi.hoisted(() => ({
	bulkScoresLoaded: vi.fn(),
	refreshBulkScores: vi.fn(),
	bulkUpdateScores: vi.fn(),
}));

const bulkScoresResponse = {
	success: true,
	data: {
		scores: [
			{
				trashId: "cf-10",
				name: "First CF",
				serviceType: "RADARR" as const,
				hasAnyModifications: false,
				templateScores: [
					{
						templateId: "instance-1-101",
						templateName: "Test Radarr",
						qualityProfileName: "Profile 101",
						scoreSet: "default",
						currentScore: 0,
						defaultScore: 0,
						isModified: false,
						isTemplateManaged: true,
					},
					{
						templateId: "instance-1-202",
						templateName: "Test Radarr",
						qualityProfileName: "Profile 202",
						scoreSet: "default",
						currentScore: 0,
						defaultScore: 0,
						isModified: false,
						isTemplateManaged: true,
					},
				],
			},
		],
	},
};

vi.mock("../../../../hooks/api/useBulkScores", async () => {
	const { useEffect, useState } = await import("react");
	return {
		useBulkScores: ({ instanceId }: { instanceId: string }) => {
			const [data, setData] = useState<typeof bulkScoresResponse | undefined>();
			const [refreshVersion, setRefreshVersion] = useState(0);
			useEffect(() => {
				hookMocks.refreshBulkScores.mockImplementation(() => {
					setRefreshVersion((version) => version + 1);
				});
				return () => {
					hookMocks.refreshBulkScores.mockReset();
				};
			}, []);
			useEffect(() => {
				setData(instanceId ? structuredClone(bulkScoresResponse) : undefined);
				hookMocks.bulkScoresLoaded(instanceId, refreshVersion);
			}, [instanceId, refreshVersion]);
			return { data, isLoading: false };
		},
	};
});

vi.mock("../../../../hooks/api/useQualityProfileScores", async (importOriginal) => {
	const actual =
		await importOriginal<typeof import("../../../../hooks/api/useQualityProfileScores")>();
	const { useState } = await import("react");
	return {
		...actual,
		useBulkUpdateScores: () => {
			const [isPending, setIsPending] = useState(false);
			return {
				isPending,
				mutateAsync: async (...args: Parameters<typeof hookMocks.bulkUpdateScores>) => {
					setIsPending(true);
					try {
						return await hookMocks.bulkUpdateScores(...args);
					} finally {
						setIsPending(false);
					}
				},
			};
		},
	};
});

vi.mock("../../../../hooks/api/useQualityProfileOverrides", () => ({
	useBulkDeleteOverrides: () => ({ isPending: false, mutateAsync: vi.fn() }),
	useDeleteOverride: () => ({ isPending: false, mutateAsync: vi.fn() }),
}));

vi.mock("../../../../hooks/api/useServicesQuery", () => ({
	useServicesQuery: () => ({
		data: [{ id: "instance-1", label: "Test Radarr", service: "radarr" }],
	}),
}));

vi.mock("../../../../hooks/useThemeGradient", () => ({
	useThemeGradient: () => ({
		gradient: {
			from: "#6366f1",
			to: "#8b5cf6",
			glow: "rgba(99, 102, 241, 0.3)",
		},
	}),
}));

import {
	BulkUpdateScoresError,
	type BulkUpdateScoresResult,
} from "../../../../hooks/api/useQualityProfileScores";
import { BulkScoreManager } from "../bulk-score-manager";

function renderWithQueryClient(children: ReactNode) {
	const queryClient = new QueryClient({
		defaultOptions: { mutations: { retry: false }, queries: { retry: false } },
	});
	return render(<QueryClientProvider client={queryClient}>{children}</QueryClientProvider>);
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

async function selectInstanceAndLoadScores() {
	fireEvent.change(screen.getByRole("combobox"), { target: { value: "instance-1" } });
	await waitFor(() => expect(screen.getAllByRole("spinbutton")).toHaveLength(2));
}

describe("BulkScoreManager partial saves", () => {
	beforeEach(() => {
		vi.clearAllMocks();
		bulkScoresResponse.data.scores[0]!.templateScores[0]!.currentScore = 0;
		bulkScoresResponse.data.scores[0]!.templateScores[1]!.currentScore = 0;
		vi.stubGlobal(
			"fetch",
			vi.fn().mockResolvedValue({
				ok: true,
				json: async () => ({ success: true, overridesByProfile: {} }),
			}),
		);
	});

	it("retries only the edit retained after a partial profile failure", async () => {
		const partialResult: BulkUpdateScoresResult = {
			totalProfiles: 2,
			successCount: 1,
			failureCount: 1,
			results: [
				{
					entryKey: "instance-1-101",
					instanceId: "instance-1",
					profileId: 101,
					success: true,
					response: { success: true, message: "Saved", updatedCount: 1 },
				},
				{
					entryKey: "instance-1-202",
					instanceId: "instance-1",
					profileId: 202,
					success: false,
					error: new Error("Profile 202 is locked"),
				},
			],
		};
		const retryResult: BulkUpdateScoresResult = {
			totalProfiles: 1,
			successCount: 1,
			failureCount: 0,
			results: [
				{
					entryKey: "instance-1-202",
					instanceId: "instance-1",
					profileId: 202,
					success: true,
					response: { success: true, message: "Saved", updatedCount: 1 },
				},
			],
		};
		hookMocks.bulkUpdateScores
			.mockRejectedValueOnce(new BulkUpdateScoresError("One profile failed", partialResult))
			.mockResolvedValueOnce(retryResult);

		renderWithQueryClient(<BulkScoreManager userId="user-1" />);
		await selectInstanceAndLoadScores();
		const [profile101Input, profile202Input] = screen.getAllByRole("spinbutton");
		fireEvent.change(profile101Input!, { target: { value: "-10000" } });
		fireEvent.change(profile202Input!, { target: { value: "125" } });
		fireEvent.click(screen.getByRole("button", { name: "Save Changes" }));

		await waitFor(() => expect(hookMocks.bulkUpdateScores).toHaveBeenCalledTimes(1));
		expect(hookMocks.bulkUpdateScores).toHaveBeenNthCalledWith(1, [
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
				changes: [{ cfTrashId: "cf-10", score: 125 }],
			},
		]);

		fireEvent.click(await screen.findByRole("button", { name: "Save Changes" }));
		await waitFor(() => expect(hookMocks.bulkUpdateScores).toHaveBeenCalledTimes(2));
		expect(hookMocks.bulkUpdateScores).toHaveBeenNthCalledWith(2, [
			{
				entryKey: "instance-1-202",
				instanceId: "instance-1",
				profileId: 202,
				changes: [{ cfTrashId: "cf-10", score: 125 }],
			},
		]);
	});

	it("retains a newer value written while the submitted save is in flight", async () => {
		const inFlightSave = createDeferred<BulkUpdateScoresResult>();
		const successfulResult: BulkUpdateScoresResult = {
			totalProfiles: 1,
			successCount: 1,
			failureCount: 0,
			results: [
				{
					entryKey: "instance-1-101",
					instanceId: "instance-1",
					profileId: 101,
					success: true,
					response: { success: true, message: "Saved", updatedCount: 1 },
				},
			],
		};
		hookMocks.bulkUpdateScores
			.mockReturnValueOnce(inFlightSave.promise)
			.mockResolvedValueOnce(successfulResult);

		renderWithQueryClient(<BulkScoreManager userId="user-1" />);
		await selectInstanceAndLoadScores();
		const profile101Input = screen.getAllByRole("spinbutton")[0]!;
		fireEvent.change(profile101Input, { target: { value: "50" } });
		fireEvent.click(screen.getByRole("button", { name: "Save Changes" }));
		await waitFor(() => expect(hookMocks.bulkUpdateScores).toHaveBeenCalledTimes(1));

		fireEvent.change(profile101Input, { target: { value: "75" } });
		expect(profile101Input).toHaveValue(75);
		act(() => inFlightSave.resolve(successfulResult));

		fireEvent.click(await screen.findByRole("button", { name: "Save Changes" }));
		await waitFor(() => expect(hookMocks.bulkUpdateScores).toHaveBeenCalledTimes(2));
		expect(hookMocks.bulkUpdateScores).toHaveBeenNthCalledWith(2, [
			{
				entryKey: "instance-1-101",
				instanceId: "instance-1",
				profileId: 101,
				changes: [{ cfTrashId: "cf-10", score: 75 }],
			},
		]);
	});

	it("disables instance switching and conflicting controls while an affected edit is saving", async () => {
		const inFlightSave = createDeferred<BulkUpdateScoresResult>();
		hookMocks.bulkUpdateScores.mockReturnValue(inFlightSave.promise);
		vi.mocked(fetch).mockResolvedValue({
			ok: true,
			json: async () => ({
				success: true,
				overridesByProfile: {
					101: [{ customFormatId: 10, score: 50 }],
				},
			}),
		} as Response);

		renderWithQueryClient(<BulkScoreManager userId="user-1" />);
		await selectInstanceAndLoadScores();
		const instanceSelect = screen.getByRole("combobox");
		const [affectedInput, unaffectedInput] = screen.getAllByRole("spinbutton");
		fireEvent.click(screen.getByRole("button", { name: "Select First CF" }));
		const removeOverride = await screen.findByRole("button", {
			name: "Remove override for First CF",
		});
		fireEvent.change(affectedInput!, { target: { value: "50" } });
		fireEvent.click(screen.getByRole("button", { name: "Save Changes" }));

		const savingButton = await screen.findByRole("button", { name: "Saving..." });
		expect(instanceSelect).toBeDisabled();
		expect(affectedInput).toBeDisabled();
		expect(unaffectedInput).toBeEnabled();
		expect(savingButton).toBeDisabled();
		expect(screen.getByRole("button", { name: "Discard" })).toBeDisabled();
		expect(screen.getByRole("button", { name: "Reset to Template" })).toBeDisabled();
		expect(removeOverride).toBeDisabled();

		const saveResult: BulkUpdateScoresResult = {
			totalProfiles: 1,
			successCount: 1,
			failureCount: 0,
			results: [
				{
					entryKey: "instance-1-101",
					instanceId: "instance-1",
					profileId: 101,
					success: true,
					response: { success: true, message: "Saved", updatedCount: 1 },
				},
			],
		};
		await act(async () => {
			inFlightSave.resolve(saveResult);
			await inFlightSave.promise;
		});
		await waitFor(() =>
			expect(screen.queryByRole("button", { name: "Saving..." })).not.toBeInTheDocument(),
		);
	});

	it("preserves a retained failed edit when refreshed query data arrives", async () => {
		const failedResult: BulkUpdateScoresResult = {
			totalProfiles: 1,
			successCount: 0,
			failureCount: 1,
			results: [
				{
					entryKey: "instance-1-202",
					instanceId: "instance-1",
					profileId: 202,
					success: false,
					error: new Error("Profile 202 is locked"),
				},
			],
		};
		hookMocks.bulkUpdateScores.mockRejectedValue(
			new BulkUpdateScoresError("Profile failed", failedResult),
		);

		renderWithQueryClient(<BulkScoreManager userId="user-1" />);
		await selectInstanceAndLoadScores();
		const profile202Input = screen.getAllByRole("spinbutton")[1]!;
		fireEvent.change(profile202Input, { target: { value: "125" } });
		fireEvent.click(screen.getByRole("button", { name: "Save Changes" }));
		await waitFor(() => expect(hookMocks.bulkUpdateScores).toHaveBeenCalledTimes(1));
		await waitFor(() => expect(profile202Input).toHaveValue(125));

		bulkScoresResponse.data.scores[0]!.templateScores[1]!.currentScore = 5;
		act(() => {
			hookMocks.refreshBulkScores();
		});
		fireEvent.click(screen.getByRole("button", { name: "Modified Only" }));

		await waitFor(() => expect(hookMocks.bulkScoresLoaded).toHaveBeenCalledWith("instance-1", 1));
		expect(screen.getAllByRole("spinbutton")[1]).toHaveValue(125);
	});

	it("restores an exact score retry from durable recovery data after reload", async () => {
		vi.mocked(fetch).mockResolvedValue({
			ok: true,
			json: async () => ({
				success: true,
				overridesByProfile: {},
				recoveryPlans: [
					{
						qualityProfileId: 101,
						entries: [
							{
								customFormatId: 10,
								operation: "SET_SCORE",
								intendedScore: 75,
								status: "UNCERTAIN",
							},
						],
						retryable: true,
						requiresManualReconciliation: false,
						retryAction: {
							method: "PATCH",
							recoveryToken: "a".repeat(64),
							scoreUpdates: [{ customFormatId: 10, score: 75 }],
						},
					},
				],
			}),
		} as Response);
		hookMocks.bulkUpdateScores.mockResolvedValue({
			totalProfiles: 1,
			successCount: 1,
			failureCount: 0,
			results: [
				{
					entryKey: "instance-1-101",
					instanceId: "instance-1",
					profileId: 101,
					success: true,
					response: { success: true, message: "Recovered", updatedCount: 1 },
				},
			],
		});

		renderWithQueryClient(<BulkScoreManager userId="user-1" />);
		await selectInstanceAndLoadScores();
		fireEvent.click(
			await screen.findByRole("button", { name: "Retry score update for Profile 101" }),
		);

		await waitFor(() => expect(hookMocks.bulkUpdateScores).toHaveBeenCalledTimes(1));
		expect(hookMocks.bulkUpdateScores).toHaveBeenCalledWith([
			{
				entryKey: "instance-1-101",
				instanceId: "instance-1",
				profileId: 101,
				changes: [{ cfTrashId: "cf-10", score: 75 }],
				recoveryToken: "a".repeat(64),
			},
		]);
	});
});
