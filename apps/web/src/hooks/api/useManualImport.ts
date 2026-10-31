"use client";

import type {
	ManualImportCandidate,
	ManualImportLegacyQuery,
	ManualImportOperationStatus,
	ManualImportServiceType,
	ManualImportSubmission,
} from "@arr/shared";
import { manualImportCandidateListSchema } from "@arr/shared";
import { useMutation, useQuery, useQueryClient } from "@tanstack/react-query";
import { useCallback, useMemo } from "react";
import {
	fetchManualImportCandidates,
	fetchManualImportProgress,
	fetchManualImportRemainderReview,
	fetchManualImportSourceProgress,
	submitManualImport,
} from "../../lib/api-client/dashboard";
import { POLLING_FAST } from "../../lib/polling-intervals";
import { manualImportKeys, QUEUE_QUERY_KEY } from "../../lib/query-keys";
import { useCurrentUser } from "./useAuth";

export const useManualImportQuery = (params: {
	instanceId: string;
	service: "sonarr" | "radarr" | "lidarr" | "readarr";
	downloadId?: string;
	folder?: string;
	enabled?: boolean;
}) => {
	const { data: user } = useCurrentUser(params.enabled !== false);
	const ownerId = user?.id ?? null;
	const queryKey = useMemo(
		() =>
			manualImportKeys.candidates(ownerId, {
				instanceId: params.instanceId,
				service: params.service,
				downloadId: params.downloadId,
				folder: params.folder,
				filterExistingFiles: true,
			}),
		[ownerId, params.instanceId, params.service, params.downloadId, params.folder],
	);

	const query = useQuery({
		queryKey,
		enabled: Boolean(ownerId && params.instanceId && params.service && params.enabled !== false),
		queryFn: () =>
			fetchManualImportCandidates({
				instanceId: params.instanceId,
				service: params.service,
				downloadId: params.downloadId,
				folder: params.folder,
			}),
	});

	const candidates = query.data?.candidates ?? [];

	return {
		...query,
		candidates,
	};
};

/** Explicit review after observed non-submission; candidates never authorize a POST. */
export const useManualImportNewAttemptReviewMutation = (ownerId: string | null) =>
	useMutation({
		mutationKey: manualImportKeys.newAttemptReview(ownerId),
		retry: false,
		mutationFn: async (query: ManualImportLegacyQuery) => {
			try {
				if (!ownerId) throw new Error();
				const response = await fetchManualImportCandidates(query);
				const candidates = manualImportCandidateListSchema.max(10000).parse(response.candidates);
				if (
					response.total !== candidates.length ||
					candidates.some((candidate) => candidate.service !== query.service)
				)
					throw new Error();
				return candidates;
			} catch {
				throw new Error("New-attempt review is unavailable. No import was requested.");
			}
		},
	});

export const useManualImportMutation = () => {
	const queryClient = useQueryClient();

	const mutation = useMutation<
		ManualImportOperationStatus,
		Error,
		ManualImportSubmission & { idempotencyKey: string }
	>({
		mutationFn: (payload) => submitManualImport(payload),
		retry: false,
		onSuccess: () => {
			// A batch can cover multiple sources; refresh candidates for each source.
			queryClient.invalidateQueries({
				queryKey: manualImportKeys.candidatesRoot,
			});
			// Also invalidate the queue since manual import affects queue items
			queryClient.invalidateQueries({ queryKey: QUEUE_QUERY_KEY });
		},
	});

	return mutation;
};

export const useManualImportProgressQuery = (params: {
	ownerId: string | null;
	idempotencyKey: string | null;
	enabled: boolean;
}) =>
	useQuery({
		queryKey: manualImportKeys.progress(params.ownerId, params.idempotencyKey),
		enabled: Boolean(params.ownerId && params.idempotencyKey && params.enabled),
		queryFn: () => fetchManualImportProgress(params.idempotencyKey!),
		retry: false,
		refetchInterval: (query) =>
			query.state.data?.state === "completed" || query.state.data?.state === "not-submitted"
				? false
				: POLLING_FAST,
		refetchIntervalInBackground: false,
	});

/** Explicit GET interaction; never polling or automatic retry. */
export const useManualImportRemainderReviewMutation = (ownerId: string | null) =>
	useMutation({
		mutationKey: manualImportKeys.remainderReview(ownerId),
		mutationFn: (request: { operationId: string; query: ManualImportLegacyQuery }) =>
			fetchManualImportRemainderReview(request.operationId, request.query),
		retry: false,
	});

export const useManualImportSourceQuery = (params: {
	ownerId: string | null;
	instanceId: string;
	service: ManualImportServiceType;
	downloadId?: string;
	cursor?: string;
	enabled: boolean;
}) =>
	useQuery({
		queryKey: manualImportKeys.source(params.ownerId, {
			instanceId: params.instanceId,
			service: params.service,
			downloadId: params.downloadId ?? null,
			cursor: params.cursor ?? null,
		}),
		enabled: Boolean(params.ownerId && params.instanceId && params.downloadId && params.enabled),
		queryFn: () =>
			fetchManualImportSourceProgress({
				instanceId: params.instanceId,
				service: params.service,
				downloadId: params.downloadId!,
				...(params.cursor ? { cursor: params.cursor } : {}),
			}),
		retry: false,
		refetchOnMount: "always",
		refetchInterval: (query) =>
			query.state.data?.kind === "none" ||
			(query.state.data?.kind === "observed" && query.state.data.operation.state === "completed") ||
			(query.state.data?.kind === "history" &&
				query.state.data.operations.every((operation) => operation.state === "completed"))
				? false
				: POLLING_FAST,
		refetchIntervalInBackground: false,
	});

export const useManualImportHelpers = () => {
	const findInitialSelection = useCallback(
		(candidates: ManualImportCandidate[]): ManualImportCandidate | undefined => {
			return candidates.find((candidate) => Boolean(candidate.downloadId));
		},
		[],
	);

	return {
		findInitialSelection,
	};
};
