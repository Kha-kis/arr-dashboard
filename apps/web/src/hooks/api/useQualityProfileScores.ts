import { useMutation, useQueryClient } from "@tanstack/react-query";
import { toast } from "sonner";
import {
	type UpdateProfileScoresPayload,
	type UpdateProfileScoresResponse,
	updateQualityProfileScores,
} from "../../lib/api-client/trash-guides";
import { bulkScoreKeys, qualityProfileKeys } from "../../lib/query-keys";

/**
 * Entry for bulk score update operations
 */
export type BulkScoreUpdateEntry = {
	entryKey: string;
	profileId: number;
	instanceId: string;
	changes: Array<{ cfTrashId: string; score: number }>;
	recoveryToken?: string;
};

/**
 * Result from a single profile score update
 */
type ProfileUpdateResultBase = {
	entryKey: string;
	profileId: number;
	instanceId: string;
};

export type ProfileUpdateResult =
	| (ProfileUpdateResultBase & {
			success: true;
			response: UpdateProfileScoresResponse;
	  })
	| (ProfileUpdateResultBase & {
			success: false;
			error: Error;
	  });

/**
 * Result from bulk score update mutation
 */
export type BulkUpdateScoresResult = {
	totalProfiles: number;
	successCount: number;
	failureCount: number;
	results: ProfileUpdateResult[];
};

export class BulkUpdateScoresError extends Error {
	readonly result: BulkUpdateScoresResult;

	constructor(message: string, result: BulkUpdateScoresResult) {
		super(message);
		this.name = "BulkUpdateScoresError";
		this.result = result;
	}
}

type PreparedBulkScoreUpdateEntry = BulkScoreUpdateEntry & {
	scoreUpdates: UpdateProfileScoresPayload["scoreUpdates"];
	validationError?: Error;
};

function prepareBulkScoreUpdateEntry(entry: BulkScoreUpdateEntry): PreparedBulkScoreUpdateEntry {
	const scoreUpdates: UpdateProfileScoresPayload["scoreUpdates"] = [];
	let validationError: Error | undefined;

	for (const { cfTrashId, score } of entry.changes) {
		const match = /^cf-(\d+)$/.exec(cfTrashId);
		const customFormatId = match?.[1] === undefined ? Number.NaN : Number(match[1]);
		if (!Number.isSafeInteger(customFormatId) || customFormatId <= 0) {
			validationError ??= new Error(
				`Invalid Custom Format ID "${cfTrashId}"; expected "cf-{positive integer}".`,
			);
			continue;
		}
		scoreUpdates.push({ customFormatId, score });
	}

	return { ...entry, scoreUpdates, validationError };
}

/**
 * Hook to update scores for a single quality profile
 */
export function useUpdateProfileScores() {
	const queryClient = useQueryClient();

	return useMutation({
		mutationFn: ({
			instanceId,
			qualityProfileId,
			payload,
		}: {
			instanceId: string;
			qualityProfileId: number;
			payload: UpdateProfileScoresPayload;
		}) => updateQualityProfileScores(instanceId, qualityProfileId, payload),
		onSuccess: (_, variables) => {
			// Invalidate related queries
			queryClient.invalidateQueries({
				queryKey: bulkScoreKeys.all,
			});
			queryClient.invalidateQueries({
				queryKey: qualityProfileKeys.overrides(variables.instanceId, variables.qualityProfileId),
			});
		},
	});
}

/**
 * Hook to bulk update scores across multiple quality profiles
 *
 * Accepts an array of profile score changes and updates each profile in order.
 */
export function useBulkUpdateScores() {
	const queryClient = useQueryClient();

	return useMutation<BulkUpdateScoresResult, Error, BulkScoreUpdateEntry[]>({
		mutationFn: async (entries) => {
			const results: ProfileUpdateResult[] = [];
			const preparedEntries = entries.map(prepareBulkScoreUpdateEntry);
			const invalidEntries = preparedEntries.filter(
				(entry): entry is PreparedBulkScoreUpdateEntry & { validationError: Error } =>
					entry.validationError !== undefined,
			);

			if (invalidEntries.length > 0) {
				const validationResults: ProfileUpdateResult[] = preparedEntries.map((entry) => ({
					entryKey: entry.entryKey,
					profileId: entry.profileId,
					instanceId: entry.instanceId,
					success: false,
					error:
						entry.validationError ??
						new Error("Not attempted because another submitted Custom Format ID was invalid."),
				}));
				throw new BulkUpdateScoresError(
					`Score updates were not started: ${invalidEntries.map((entry) => entry.validationError.message).join(" ")}`,
					{
						totalProfiles: entries.length,
						successCount: 0,
						failureCount: entries.length,
						results: validationResults,
					},
				);
			}

			for (const entry of preparedEntries) {
				const { entryKey, profileId, instanceId, recoveryToken, scoreUpdates } = entry;

				try {
					const response = await updateQualityProfileScores(
						instanceId,
						profileId,
						recoveryToken ? { recoveryToken, scoreUpdates } : { scoreUpdates },
					);

					results.push({
						entryKey,
						profileId,
						instanceId,
						success: true,
						response,
					});
				} catch (error) {
					results.push({
						entryKey,
						profileId,
						instanceId,
						success: false,
						error: error instanceof Error ? error : new Error(String(error)),
					});
				}
			}

			const successCount = results.filter((r) => r.success).length;
			const failureCount = results.filter((r) => !r.success).length;

			// If there were any failures, throw an error with details
			if (failureCount > 0) {
				const errorMessages = results
					.filter((r) => !r.success)
					.map((r) => r.error?.message || "Unknown error")
					.join(", ");

				throw new BulkUpdateScoresError(
					`Failed to update ${failureCount} quality profile(s): ${errorMessages}`,
					{
						totalProfiles: entries.length,
						successCount,
						failureCount,
						results,
					},
				);
			}

			return {
				totalProfiles: entries.length,
				successCount,
				failureCount,
				results,
			};
		},
		onSuccess: (result) => {
			toast.success(
				`Saved scores for ${result.successCount} quality profile${result.successCount === 1 ? "" : "s"}`,
			);

			// Invalidate cache keys for all successfully updated profiles
			queryClient.invalidateQueries({
				queryKey: bulkScoreKeys.all,
			});

			// Invalidate individual quality profile override queries
			for (const profileResult of result.results) {
				if (profileResult.success) {
					queryClient.invalidateQueries({
						queryKey: qualityProfileKeys.overrides(
							profileResult.instanceId,
							profileResult.profileId,
						),
					});
				}
			}
		},
		onError: (error) => {
			if (error instanceof BulkUpdateScoresError && error.result.successCount > 0) {
				queryClient.invalidateQueries({
					queryKey: bulkScoreKeys.all,
				});
				for (const profileResult of error.result.results) {
					if (profileResult.success) {
						queryClient.invalidateQueries({
							queryKey: qualityProfileKeys.overrides(
								profileResult.instanceId,
								profileResult.profileId,
							),
						});
					}
				}
				toast.warning(
					`Saved scores for ${error.result.successCount} of ${error.result.totalProfiles} quality profiles`,
					{
						description: `${error.result.failureCount} quality profile${error.result.failureCount === 1 ? "" : "s"} failed. Failed edits were kept for retry.`,
					},
				);
				return;
			}
			toast.error("No quality profile scores were saved", {
				description: error.message,
			});
		},
	});
}
