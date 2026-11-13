import type {
	ManualImportCandidate,
	ManualImportRemainderReview,
	ManualImportSourceStatus,
} from "@arr/shared";
import { useQueryClient } from "@tanstack/react-query";
import { useEffect, useRef, useState } from "react";
import { useCurrentUser } from "../../../hooks/api/useAuth";
import {
	useManualImportMutation,
	useManualImportNewAttemptReviewMutation,
	useManualImportProgressQuery,
	useManualImportRemainderReviewMutation,
	useManualImportSourceQuery,
} from "../../../hooks/api/useManualImport";
import { ApiError } from "../../../lib/api-client/base";
import { manualImportKeys } from "../../../lib/query-keys";
import {
	ImportAttemptStorageError,
	importScopeKey,
	importSelectionHash,
	type RetainedImportAttempt,
	readImportAttempt,
	retainImportAttempt,
	retainNewImportAttempt,
	retainRemainingImportAttempt,
} from "../lib/import-attempt";
import { hasValidSelections } from "../store";
import type { ManualImportSelection } from "../types";

interface UseImportSubmissionParams {
	instanceId: string;
	service: "sonarr" | "radarr" | "lidarr" | "readarr";
	importMode: "auto" | "copy" | "move";
	open: boolean;
	downloadId?: string;
	folder?: string;
	onSuccess: (importedCount: number) => void;
}

export const useImportSubmission = ({
	instanceId,
	service,
	importMode,
	open,
	downloadId,
	folder,
	onSuccess,
}: UseImportSubmissionParams) => {
	const [error, setError] = useState<string | undefined>();
	const { data: user } = useCurrentUser(open);
	const ownerId = user?.id ?? null;
	const reviewMutation = useManualImportRemainderReviewMutation(ownerId);
	const newReviewMutation = useManualImportNewAttemptReviewMutation(ownerId);
	const queryClient = useQueryClient();
	const mutation = useManualImportMutation();
	const binding = JSON.stringify([
		ownerId,
		instanceId,
		service,
		downloadId ?? null,
		folder ?? null,
	]);
	const currentBinding = useRef(binding);
	currentBinding.current = binding;
	const inFlight = useRef(false);
	const reviewInFlight = useRef(false);
	const reviewEpoch = useRef(0);
	const isOpen = useRef(open);
	isOpen.current = open;
	const [busy, setBusy] = useState(false);
	const [context, setContext] = useState<{
		binding: string;
		storageKey: string;
		attempt: RetainedImportAttempt | null;
	} | null>(null);
	const active = context?.binding === binding ? context : null;
	const [remainingContext, setRemainingContext] = useState<{
		binding: string;
		expectedPreviousKey: string | null;
		review: ManualImportRemainderReview;
	} | null>(null);
	const remainingReview =
		open && remainingContext?.binding === binding ? remainingContext.review : null;
	const [newAttemptContext, setNewAttemptContext] = useState<{
		binding: string;
		expectedPreviousKey: string | null;
		candidates: ManualImportCandidate[];
	} | null>(null);
	const newAttemptReview =
		open && newAttemptContext?.binding === binding ? newAttemptContext : null;
	const [historyNavigation, setHistoryNavigation] = useState<{
		binding: string;
		cursors: Array<string | null>;
		selectedId: string | null;
	} | null>(null);
	const navigation = historyNavigation?.binding === binding ? historyNavigation : null;
	const cursor = navigation?.cursors.at(-1) ?? null;
	useEffect(() => {
		// Reopening must revalidate browser state, not reuse a prior ready context.
		setContext(null);
		setHistoryNavigation(null);
		reviewEpoch.current += 1;
		setRemainingContext(null);
		setNewAttemptContext(null);
		if (!open || !ownerId) return;
		let cancelled = false;
		importScopeKey(binding)
			.then((storageKey) => {
				const attempt = readImportAttempt(storageKey);
				if (!cancelled) {
					setContext({ binding, storageKey, attempt });
					setError(undefined);
				}
			})
			.catch(() => {
				if (!cancelled) {
					setContext(null);
					setError(
						"Browser attempt recovery is unavailable. No new import was requested. Check existing ARR activity before changing browser state.",
					);
				}
			});
		return () => {
			cancelled = true;
		};
	}, [binding, ownerId, open]);
	const trackedProgress = useManualImportProgressQuery({
		ownerId,
		idempotencyKey: active?.attempt?.idempotencyKey ?? null,
		enabled: open && !busy,
	});
	const originalNotFound =
		trackedProgress.error instanceof ApiError && trackedProgress.error.status === 404;
	const sourceRequired = Boolean(downloadId && (!active?.attempt || originalNotFound));
	const sourceProgress = useManualImportSourceQuery({
		ownerId,
		instanceId,
		service,
		downloadId,
		cursor: cursor ?? undefined,
		enabled: open && !busy && Boolean(active) && sourceRequired,
	});
	// A cached none is only presentation readiness, never server-side submission authority.
	const sourceReady =
		sourceProgress.data?.kind === "none" && !sourceProgress.isError && !sourceProgress.isFetching;
	const observingSource = sourceRequired && !sourceReady;
	const sourceData: ManualImportSourceStatus | undefined = sourceProgress.data;
	const sourceHistory = observingSource && sourceData?.kind === "history" ? sourceData : undefined;
	const selectedHistory = sourceHistory?.operations.find(
		(operation) => operation.operationId === navigation?.selectedId,
	);
	const progress = observingSource
		? {
				...sourceProgress,
				data:
					sourceProgress.data?.kind === "observed"
						? sourceProgress.data.operation
						: selectedHistory,
			}
		: trackedProgress;
	const observeOnly =
		Boolean((active?.attempt && !originalNotFound) || observingSource) &&
		!remainingReview &&
		!newAttemptReview;
	const cancelRemainingReview = () => {
		reviewEpoch.current += 1;
		setRemainingContext(null);
		setNewAttemptContext(null);
		setError(undefined);
	};
	// Cached inspection confers no authority; disabling a focused control on every poll loses keyboard focus.
	const historyReady = Boolean(sourceHistory && !sourceProgress.isError);
	const inspectHistory = (operationId: string) => {
		if (
			!historyReady ||
			!sourceHistory?.operations.some((operation) => operation.operationId === operationId)
		)
			return;
		cancelRemainingReview();
		setHistoryNavigation({
			binding,
			cursors: navigation?.cursors ?? [null],
			selectedId: operationId,
		});
	};
	const nextHistoryPage = () => {
		if (!historyReady || !sourceHistory?.nextCursor) return;
		cancelRemainingReview();
		setHistoryNavigation({
			binding,
			cursors: [...(navigation?.cursors ?? [null]), sourceHistory.nextCursor],
			selectedId: null,
		});
	};
	const previousHistoryPage = () => {
		if (!historyReady || !navigation || navigation.cursors.length < 2) return;
		cancelRemainingReview();
		setHistoryNavigation({ binding, cursors: navigation.cursors.slice(0, -1), selectedId: null });
	};
	const notified = useRef(new Set<string>());
	useEffect(() => {
		// Discovered historical completion is displayed, not a new successful action.
		if (open && !trackedProgress.isError && trackedProgress.data?.state === "completed") {
			const notification = `${ownerId}:${trackedProgress.data.operationId}`;
			if (!notified.current.has(notification)) {
				notified.current.add(notification);
				onSuccess(trackedProgress.data.verifiedFileCount);
			}
		}
	}, [open, ownerId, trackedProgress.data, trackedProgress.isError, onSuccess]);

	const canReviewRemaining = Boolean(
		active &&
			ownerId &&
			downloadId &&
			!progress.isError &&
			progress.data?.canConsiderNewAttempt &&
			(["unknown", "partial", "failed"].includes(progress.data.state) ||
				(progress.data.state === "not-submitted" && Boolean(active.attempt?.remainderOf))) &&
			!remainingReview &&
			!newAttemptReview &&
			!busy,
	);
	const canReviewNewAttempt = Boolean(
		active &&
			ownerId &&
			downloadId &&
			!progress.isError &&
			progress.data?.state === "not-submitted" &&
			progress.data.canConsiderNewAttempt &&
			!active.attempt?.remainderOf &&
			!remainingReview &&
			!newAttemptReview &&
			!busy,
	);
	const reviewNewAttempt = async () => {
		if (!canReviewNewAttempt || !active || !downloadId || reviewInFlight.current) return;
		const epoch = ++reviewEpoch.current;
		reviewInFlight.current = true;
		setError(undefined);
		try {
			const candidates = await newReviewMutation.mutateAsync({ instanceId, service, downloadId });
			if (currentBinding.current === binding && isOpen.current && reviewEpoch.current === epoch)
				setNewAttemptContext({
					binding,
					expectedPreviousKey: active.attempt?.idempotencyKey ?? null,
					candidates,
				});
		} catch {
			if (currentBinding.current === binding && isOpen.current && reviewEpoch.current === epoch)
				setError(
					"New-attempt review is unavailable. Check existing progress or ARR activity; no new import was requested.",
				);
		} finally {
			reviewInFlight.current = false;
		}
	};
	const reviewRemaining = async () => {
		if (!canReviewRemaining || !active || !downloadId || !progress.data || reviewInFlight.current)
			return;
		const operationId =
			progress.data.state === "not-submitted"
				? active.attempt?.remainderOf
				: progress.data.operationId;
		if (!operationId) return;
		const epoch = ++reviewEpoch.current;
		reviewInFlight.current = true;
		setError(undefined);
		setRemainingContext(null);
		try {
			const review = await reviewMutation.mutateAsync({
				operationId,
				query: { instanceId, service, downloadId },
			});
			if (currentBinding.current === binding && isOpen.current && reviewEpoch.current === epoch)
				setRemainingContext({
					binding,
					expectedPreviousKey: active.attempt?.idempotencyKey ?? null,
					review,
				});
		} catch {
			if (currentBinding.current === binding && isOpen.current && reviewEpoch.current === epoch)
				setError(
					"Remaining-file review is unavailable. Check the original progress or ARR activity; no new import was requested.",
				);
		} finally {
			reviewInFlight.current = false;
		}
	};

	const submit = async (selections: Record<string, ManualImportSelection>) => {
		if (inFlight.current) return;
		setError(undefined);
		if (!active || !ownerId) {
			setError("Attempt recovery is not ready. No import was requested.");
			return;
		}
		if (observeOnly) {
			if (!progress.isFetching) await progress.refetch();
			return;
		}

		const selectionsForThisService = Object.values(selections).filter(
			(selection) => selection.service === service && selection.instanceId === instanceId,
		);

		if (selectionsForThisService.length === 0) {
			setError("Select at least one file to import.");
			return;
		}

		if (
			!hasValidSelections(
				Object.fromEntries(selectionsForThisService.map((selection, index) => [index, selection])),
				service,
			)
		) {
			setError("At least one selected file is missing required mappings.");
			return;
		}

		try {
			inFlight.current = true;
			setBusy(true);
			const files = selectionsForThisService.map((selection) => selection.values);
			const mode = remainingReview?.importMode ?? importMode;
			const remainderOf = newAttemptReview
				? undefined
				: (remainingReview?.operation.operationId ?? active.attempt?.remainderOf);
			const selectionHash = await importSelectionHash(files, mode, remainderOf);
			if (currentBinding.current !== binding || !isOpen.current) return;
			const attempt = newAttemptReview
				? retainNewImportAttempt(
						active.storageKey,
						selectionHash,
						mode,
						newAttemptReview.expectedPreviousKey,
					)
				: remainingReview && remainingContext
					? retainRemainingImportAttempt(
							active.storageKey,
							selectionHash,
							remainingReview.importMode,
							remainingReview.operation.operationId,
							remainingContext.expectedPreviousKey,
						)
					: retainImportAttempt(active.storageKey, selectionHash, mode);
			setContext({ ...active, attempt });
			setRemainingContext(null);
			setNewAttemptContext(null);
			const status = await mutation.mutateAsync({
				instanceId,
				service,
				importMode: mode,
				files,
				idempotencyKey: attempt.idempotencyKey,
				...(attempt.remainderOf ? { remainderOf: attempt.remainderOf } : {}),
			});
			if (currentBinding.current === binding)
				queryClient.setQueryData(
					manualImportKeys.progress(ownerId, attempt.idempotencyKey),
					status,
				);
		} catch (error) {
			if (currentBinding.current === binding)
				setError(
					error instanceof ImportAttemptStorageError
						? error.message
						: "Import response is unavailable. Check retained progress and existing ARR activity before starting new work.",
				);
		} finally {
			inFlight.current = false;
			setBusy(false);
		}
	};

	return {
		submit,
		error,
		setError,
		isPending: busy || mutation.isPending,
		ready: Boolean(active && ownerId),
		attempt: active?.attempt ?? null,
		progress,
		observeOnly,
		sourceChecking: observingSource && !sourceProgress.data && !sourceProgress.isError,
		sourceUnavailable: observingSource && sourceProgress.data?.kind === "unavailable",
		sourceHistory,
		inspectHistory,
		nextHistoryPage,
		previousHistoryPage,
		historyReady,
		hasPreviousHistoryPage: Boolean(navigation && navigation.cursors.length > 1),
		retryOriginalAllowed: Boolean(active?.attempt && originalNotFound && !observingSource),
		remainingReview,
		canReviewRemaining,
		reviewRemaining,
		cancelRemainingReview,
		newAttemptReview,
		canReviewNewAttempt,
		reviewNewAttempt,
		isReviewing: reviewMutation.isPending || newReviewMutation.isPending,
	};
};
