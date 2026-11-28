"use client";

import {
	AlertTriangle,
	CheckSquare,
	Download,
	Filter,
	FolderOpen,
	Loader2,
	X,
	XSquare,
} from "lucide-react";
import { useCallback, useEffect, useMemo, useRef, useState } from "react";
import { useShallow } from "zustand/shallow";
import { PremiumSkeleton } from "../../../components/layout/premium-components";
import { Alert, AlertDescription, AlertTitle } from "../../../components/ui/alert";
import { Button } from "../../../components/ui/button";
import { useManualImportQuery } from "../../../hooks/api/useManualImport";
import { useFocusTrap } from "../../../hooks/useFocusTrap";
import { useThemeGradient } from "../../../hooks/useThemeGradient";
import { getLinuxInstanceName, getLinuxSavePath, useIncognitoMode } from "../../../lib/incognito";
import { SEMANTIC_COLORS, SERVICE_GRADIENTS } from "../../../lib/theme-gradients";
import { candidateKey, describeRejections } from "../helpers";
import { useAutoSelection } from "../hooks/use-auto-selection";
import { useEpisodeSelection } from "../hooks/use-episode-selection";
import { useImportSubmission } from "../hooks/use-import-submission";
import { buildSubmissionDefaults } from "../lib/submission-builder";
import { getSelectionForCandidate, useManualImportStore } from "../store";
import type { ManualImportCandidateUnion, ManualImportModalProps } from "../types";
import { CandidateCard } from "./candidate-card";

const importModeOptions = [
	{ value: "auto", label: "Auto (Move)" },
	{ value: "move", label: "Move" },
	{ value: "copy", label: "Copy" },
] as const;

type ImportMode = (typeof importModeOptions)[number]["value"];

// Use centralized service colors
const SERVICE_COLORS: Record<"sonarr" | "radarr" | "lidarr" | "readarr", string> = {
	sonarr: SERVICE_GRADIENTS.sonarr.from,
	radarr: SERVICE_GRADIENTS.radarr.from,
	lidarr: SERVICE_GRADIENTS.lidarr.from,
	readarr: SERVICE_GRADIENTS.readarr.from,
};

/**
 * Premium Manual Import Modal
 *
 * Modal for importing files with:
 * - Glassmorphic backdrop and container
 * - Service-branded header (Sonarr cyan, Radarr orange)
 * - Theme-aware form controls
 * - Premium selection styling
 */
export const ManualImportModal = ({
	instanceId,
	instanceName,
	service,
	downloadId,
	folder,
	open,
	onOpenChange,
	onCompleted,
	reviewNavigation,
}: ManualImportModalProps) => {
	const { gradient: themeGradient } = useThemeGradient();
	const [incognitoMode] = useIncognitoMode();
	const serviceColor = SERVICE_COLORS[service] ?? themeGradient.from;
	const { selections, toggleSelection, clear } = useManualImportStore(
		useShallow((state) => ({
			selections: state.selections,
			toggleSelection: state.toggleSelection,
			clear: state.clear,
		})),
	);
	const closeModal = useCallback(() => onOpenChange(false), [onOpenChange]);
	const focusTrapRef = useFocusTrap<HTMLDivElement>(open, closeModal);
	const closeButtonRef = useRef<HTMLButtonElement>(null);
	const [showSelectedOnly, setShowSelectedOnly] = useState(false);
	const [importMode, setImportMode] = useState<ImportMode>("auto");
	const [isFocused, setIsFocused] = useState(false);

	const {
		submit,
		error: selectionError,
		setError: setSelectionError,
		isPending,
		ready,
		attempt,
		progress,
		retryOriginalAllowed,
		observeOnly,
		sourceChecking,
		sourceUnavailable,
		sourceHistory,
		inspectHistory,
		nextHistoryPage,
		previousHistoryPage,
		historyReady,
		hasPreviousHistoryPage,
		remainingReview,
		canReviewRemaining,
		reviewRemaining,
		cancelRemainingReview,
		isReviewing,
		newAttemptReview,
		canReviewNewAttempt,
		reviewNewAttempt,
	} = useImportSubmission({
		instanceId,
		service,
		importMode,
		open,
		downloadId,
		folder,
		onSuccess: (importedCount) => onCompleted?.({ status: "success", imported: importedCount }),
	});
	const changeHistoryPage = (changePage: () => void) => {
		// Page controls unmount while loading; retain focus on a persistent dialog control.
		closeButtonRef.current?.focus();
		changePage();
	};
	useEffect(() => {
		if (!open) return;
		const focused = document.activeElement;
		if (
			focused === document.body ||
			(focused instanceof HTMLElement &&
				focused.matches(":disabled") &&
				focusTrapRef.current?.contains(focused))
		)
			closeButtonRef.current?.focus();
	}, [
		open,
		progress.isError,
		progress.data?.operationId,
		remainingReview,
		newAttemptReview,
		isReviewing,
		focusTrapRef,
	]);
	const query = useManualImportQuery({
		instanceId,
		service,
		downloadId,
		folder,
		enabled: open && ready && !observeOnly && !remainingReview && !newAttemptReview,
	});

	const candidates =
		remainingReview?.candidates ?? newAttemptReview?.candidates ?? query.candidates;

	const { toggleEpisode, selectAllEpisodes, clearEpisodes } = useEpisodeSelection();

	// Select all candidates with their episodes
	const handleSelectAll = useCallback(() => {
		for (const candidate of candidates) {
			const defaults = buildSubmissionDefaults(candidate, downloadId);
			if (!defaults) {
				continue;
			}
			// Only add if not already selected
			const existing = getSelectionForCandidate(selections, candidate);
			if (!existing) {
				toggleSelection(candidate, instanceId, defaults.downloadId, defaults.values);
			}
			// Select all episodes for Sonarr candidates
			selectAllEpisodes(candidate);
		}
	}, [candidates, downloadId, selections, toggleSelection, instanceId, selectAllEpisodes]);

	// Clear all selections
	const handleClearAll = useCallback(() => {
		clear();
	}, [clear]);

	const rejectionCount = useMemo(
		() => candidates.filter((candidate) => Boolean(describeRejections(candidate))).length,
		[candidates],
	);

	const selectionsForService = useMemo(
		() =>
			Object.values(selections).filter(
				(selection) => selection.service === service && selection.instanceId === instanceId,
			),
		[selections, service, instanceId],
	);

	const selectedCount = selectionsForService.length;

	useAutoSelection(
		open && ready && !observeOnly && !remainingReview && !newAttemptReview,
		query.isLoading,
		candidates,
		selections,
		instanceId,
		downloadId,
		toggleSelection,
	);

	useEffect(() => {
		if (!open) {
			return;
		}
		clear();
		setSelectionError(undefined);
		setShowSelectedOnly(false);
		setImportMode("auto");
	}, [open, clear, instanceId, service, downloadId, folder, setSelectionError]);
	useEffect(() => {
		if (attempt) setImportMode(attempt.importMode);
	}, [attempt, open]);
	useEffect(() => {
		if (!remainingReview) return;
		clear();
		setImportMode(remainingReview.importMode);
		setShowSelectedOnly(false);
	}, [remainingReview, clear]);
	useEffect(() => {
		if (!newAttemptReview) return;
		clear();
		setShowSelectedOnly(false);
	}, [newAttemptReview, clear]);

	const visibleCandidates = useMemo(() => {
		let list = candidates;
		if (showSelectedOnly) {
			list = list.filter((candidate) => Boolean(getSelectionForCandidate(selections, candidate)));
		}
		return list;
	}, [candidates, showSelectedOnly, selections]);

	const totalCandidates = candidates.length;
	const visibleCount = visibleCandidates.length;

	const handleClose = useCallback(
		(next: boolean) => {
			if (!next) {
				clear();
				setSelectionError(undefined);
			}
			onOpenChange(next);
		},
		[clear, onOpenChange, setSelectionError],
	);

	const handleToggleCandidate = useCallback(
		(candidate: ManualImportCandidateUnion) => {
			const defaults = buildSubmissionDefaults(candidate, downloadId);
			if (!defaults) {
				setSelectionError(
					"ARR did not expose a download identifier for this download. Use the ARR UI instead.",
				);
				return;
			}
			setSelectionError(undefined);
			toggleSelection(candidate, instanceId, defaults.downloadId, defaults.values);
		},
		[downloadId, toggleSelection, instanceId, setSelectionError],
	);

	const handleSubmit = async () => {
		await submit(selections);
	};

	if (!open) {
		return null;
	}

	return (
		<div
			className="fixed inset-0 z-modal-backdrop flex items-center justify-center p-4 animate-in fade-in duration-200"
			onClick={() => handleClose(false)}
			role="dialog"
			aria-modal="true"
			aria-labelledby="manual-import-title"
		>
			{/* Backdrop */}
			<div className="absolute inset-0 bg-black/70 backdrop-blur-xs" />

			{/* Modal */}
			<div
				ref={focusTrapRef}
				className="relative flex w-full max-w-5xl max-h-[90vh] flex-col overflow-hidden rounded-2xl border border-border/50 bg-card/95 backdrop-blur-xl shadow-2xl animate-in zoom-in-95 slide-in-from-bottom-4 duration-300"
				style={{
					boxShadow: `0 25px 50px -12px rgba(0, 0, 0, 0.5), 0 0 0 1px ${serviceColor}15`,
				}}
				onClick={(event) => event.stopPropagation()}
			>
				{/* Close Button */}
				<button
					ref={closeButtonRef}
					type="button"
					onClick={() => handleClose(false)}
					disabled={isPending}
					aria-label="Close modal"
					className="absolute right-4 top-4 z-10 flex h-8 w-8 items-center justify-center rounded-lg bg-black/50 text-white/70 transition-colors hover:bg-black/70 hover:text-white disabled:opacity-50"
				>
					<X className="h-4 w-4" />
				</button>

				<div className="min-h-0 overflow-y-auto">
					{/* Header */}
					<div
						className="p-6 border-b border-border/30"
						style={{
							background: `linear-gradient(135deg, ${serviceColor}08, transparent)`,
						}}
					>
						<div className="flex items-center gap-4">
							<div
								className="flex h-12 w-12 items-center justify-center rounded-xl shrink-0"
								style={{
									background: `${serviceColor}20`,
									border: `1px solid ${serviceColor}30`,
								}}
							>
								<FolderOpen className="h-6 w-6" style={{ color: serviceColor }} />
							</div>
							<div className="min-w-0 pr-6 break-all">
								<h2 id="manual-import-title" className="text-xl font-bold text-foreground">
									Manual Import -{" "}
									{incognitoMode ? getLinuxInstanceName(instanceName) : instanceName}
								</h2>
								<p className="text-sm text-muted-foreground">
									{downloadId
										? incognitoMode
											? "Download identifier hidden"
											: `Download: ${downloadId}`
										: folder
											? `Folder: ${incognitoMode ? getLinuxSavePath(folder) : folder}`
											: "Interactive manual import"}
								</p>
							</div>
						</div>
					</div>

					{/* Error Messages */}
					<div className="px-6 pt-4 space-y-3">
						{(attempt || observeOnly) && (
							<Alert
								variant={
									progress.data?.state === "completed" && !progress.isError ? "success" : "info"
								}
							>
								<AlertTitle>
									{progress.isError
										? "Cached progress unavailable"
										: sourceChecking
											? "Checking existing import evidence"
											: sourceUnavailable
												? "Existing import evidence unavailable"
												: progress.data
													? {
															preparing: "Preparing import",
															submitting: "Import request in progress",
															pending: "Import requested; awaiting file verification",
															unknown: "Import outcome unavailable",
															partial: "Import partially verified",
															completed: "All selected files verified",
															failed: "Import command failed",
															"not-submitted": "Import was not submitted",
														}[progress.data.state]
													: sourceHistory
														? "Recorded import attempts"
														: "Import outcome unavailable"}
								</AlertTitle>
								<AlertDescription>
									{progress.data && (
										<p>
											{progress.data.verifiedFileCount} of {progress.data.selectedFileCount} files
											verified{progress.isError ? " in the last available observation" : ""}.
										</p>
									)}
									<p>
										{retryOriginalAllowed
											? "No recorded attempt was found. Retry only the original selection with its retained key."
											: "Checking progress reads cached evidence only; it does not send another import command."}
									</p>
									{sourceUnavailable && (
										<p>
											An existing import is recorded, but its file evidence is not available. Check
											again or review activity in the ARR app; no new import was requested.
										</p>
									)}
									{progress.isError && (
										<p>
											Current evidence is unavailable. The attempt remains retained; check again
											before starting new work.
										</p>
									)}
								</AlertDescription>
							</Alert>
						)}
						{sourceHistory && (
							<section aria-label="Recorded import attempts" className="space-y-3">
								<p className="text-sm text-muted-foreground">
									These are distinct recorded selections, not a current or latest attempt. Inspect
									one to view its cached outcome; no import is requested.
								</p>
								{sourceHistory.operations.length === 0 && (
									<p className="text-sm text-muted-foreground">
										No more recorded attempts on this page.
									</p>
								)}
								<ul className="space-y-2">
									{sourceHistory.operations.map((operation, index) => (
										<li
											key={operation.operationId}
											className="flex flex-wrap items-center justify-between gap-2 rounded-lg border border-border p-3"
										>
											<p className="text-sm">
												Recorded attempt {index + 1}: {operation.state};{" "}
												{operation.verifiedFileCount} of {operation.selectedFileCount} files
												verified
												{progress.isError ? " in the last available observation" : ""}.
											</p>
											<Button
												type="button"
												variant="outline"
												size="sm"
												disabled={!historyReady}
												onClick={() => inspectHistory(operation.operationId)}
												aria-label={`Inspect recorded attempt ${index + 1}`}
											>
												Inspect
											</Button>
										</li>
									))}
								</ul>
								<div className="flex flex-wrap gap-2">
									<Button
										type="button"
										variant="outline"
										size="sm"
										disabled={!historyReady || !hasPreviousHistoryPage}
										onClick={() => changeHistoryPage(previousHistoryPage)}
									>
										Previous attempts
									</Button>
									<Button
										type="button"
										variant="outline"
										size="sm"
										disabled={!historyReady || !sourceHistory.nextCursor}
										onClick={() => changeHistoryPage(nextHistoryPage)}
									>
										Next attempts
									</Button>
								</div>
							</section>
						)}
						{remainingReview && (
							<Alert variant="info">
								<AlertTitle>Review remaining selection</AlertTitle>
								<AlertDescription>
									<p>
										{remainingReview.sourceVerifiedFileCount} of {remainingReview.sourceFileCount}{" "}
										original source files verified; {remainingReview.candidates.length} available
										for review; {remainingReview.unavailableFileCount} unavailable.
									</p>
									{service === "sonarr" && (
										<p>
											{remainingReview.verifiedEpisodeCount} episodes already verified and excluded
											from this selection.
										</p>
									)}
									<p>
										Choose remaining files explicitly. This uses the original{" "}
										{remainingReview.importMode} mode and a new retained attempt. The server
										rechecks targets and history before importing. Unavailable targets do not imply
										imported success.
									</p>
								</AlertDescription>
							</Alert>
						)}
						{newAttemptReview && (
							<Alert>
								<AlertTitle>Review new import attempt</AlertTitle>
								<AlertDescription>
									The earlier attempt was not submitted. Choose current candidates explicitly;
									submitting retains a new attempt and rechecks targets and all source history.
									Review does not import files or discard the earlier operation. If source history
									contains an earlier submitted operation, inspect that operation and review its
									remaining files instead.
								</AlertDescription>
							</Alert>
						)}
						{query.isError && !observeOnly && !remainingReview && !newAttemptReview && (
							<div
								className="flex items-center gap-2 rounded-xl px-4 py-3 text-sm animate-in fade-in slide-in-from-bottom-2"
								style={{
									backgroundColor: SEMANTIC_COLORS.error.bg,
									border: `1px solid ${SEMANTIC_COLORS.error.border}`,
									color: SEMANTIC_COLORS.error.text,
								}}
							>
								<AlertTriangle className="h-4 w-4 shrink-0" />
								<span>
									Manual import candidates are unavailable. Check the connection and try again.
								</span>
							</div>
						)}

						{selectionError && (
							<div
								className="flex items-center gap-2 rounded-xl px-4 py-3 text-sm animate-in fade-in slide-in-from-bottom-2"
								style={{
									backgroundColor: SEMANTIC_COLORS.error.bg,
									border: `1px solid ${SEMANTIC_COLORS.error.border}`,
									color: SEMANTIC_COLORS.error.text,
								}}
							>
								<AlertTriangle className="h-4 w-4 shrink-0" />
								<span>{selectionError}</span>
							</div>
						)}
					</div>

					{!observeOnly && (
						<>
							{/* Controls */}
							<div className="px-6 pt-4">
								<div className="rounded-xl border border-border/50 bg-card/30 backdrop-blur-xs p-4 space-y-4">
									{/* Stats Row */}
									<div className="flex flex-wrap items-center gap-4 text-sm">
										<div className="flex items-center gap-2">
											<span className="text-muted-foreground">Total files:</span>
											<span className="font-medium text-foreground">{totalCandidates}</span>
										</div>
										<div className="flex items-center gap-2">
											<span className="text-muted-foreground">Visible:</span>
											<span className="font-medium text-foreground">{visibleCount}</span>
										</div>
										<div className="flex items-center gap-2">
											<span className="text-muted-foreground">Selected:</span>
											<span
												className="font-semibold"
												style={{ color: selectedCount > 0 ? themeGradient.from : undefined }}
											>
												{selectedCount}
											</span>
										</div>
										{rejectionCount > 0 && (
											<div
												className="flex items-center gap-1 rounded-full px-2.5 py-0.5 text-xs font-medium"
												style={{
													backgroundColor: SEMANTIC_COLORS.warning.bg,
													border: `1px solid ${SEMANTIC_COLORS.warning.border}`,
													color: SEMANTIC_COLORS.warning.text,
												}}
											>
												<AlertTriangle className="h-3 w-3" />
												{rejectionCount} rejected
											</div>
										)}
									</div>

									{/* Controls Row */}
									<div className="flex flex-wrap items-center gap-4">
										<label className="flex flex-col gap-1.5">
											<span className="text-xs uppercase tracking-wider text-muted-foreground font-medium">
												Import mode
											</span>
											<select
												value={importMode}
												onChange={(event) => setImportMode(event.target.value as ImportMode)}
												onFocus={() => setIsFocused(true)}
												onBlur={() => setIsFocused(false)}
												className="rounded-lg border bg-card/50 backdrop-blur-xs px-3 py-2 text-sm text-foreground transition-all duration-200 focus:outline-hidden appearance-none cursor-pointer min-w-[200px]"
												style={{
													borderColor: isFocused ? themeGradient.from : "hsl(var(--border) / 0.5)",
													boxShadow: isFocused ? `0 0 0 1px ${themeGradient.from}` : undefined,
												}}
												disabled={isPending || Boolean(remainingReview)}
											>
												{importModeOptions.map((option) => (
													<option key={option.value} value={option.value}>
														{option.label}
													</option>
												))}
											</select>
										</label>

										<label className="flex items-center gap-2 cursor-pointer group">
											<div
												className="relative h-5 w-9 rounded-full transition-colors duration-200"
												style={{
													background: showSelectedOnly
														? `linear-gradient(135deg, ${themeGradient.from}, ${themeGradient.to})`
														: "hsl(var(--muted) / 0.5)",
												}}
											>
												<div
													className={`absolute top-0.5 h-4 w-4 rounded-full bg-white shadow-sm transition-transform duration-200 ${
														showSelectedOnly ? "translate-x-4" : "translate-x-0.5"
													}`}
												/>
											</div>
											<input
												type="checkbox"
												className="sr-only"
												checked={showSelectedOnly}
												onChange={(event) => setShowSelectedOnly(event.target.checked)}
												disabled={isPending}
											/>
											<span className="text-sm text-muted-foreground group-hover:text-foreground transition-colors flex items-center gap-1.5">
												<Filter className="h-3.5 w-3.5" />
												Show selected only
											</span>
										</label>

										<div className="ml-auto flex gap-2">
											<Button
												variant="outline"
												size="sm"
												className="gap-1.5"
												onClick={handleSelectAll}
												disabled={isPending || candidates.length === 0}
											>
												<CheckSquare className="h-3.5 w-3.5" />
												Select All
											</Button>
											<Button
												variant="outline"
												size="sm"
												className="gap-1.5"
												onClick={handleClearAll}
												disabled={isPending || selectedCount === 0}
											>
												<XSquare className="h-3.5 w-3.5" />
												Clear All
											</Button>
										</div>
									</div>
								</div>
							</div>

							{/* Candidate List */}
							<div className="px-6 py-4 max-h-[420px] overflow-y-auto space-y-2">
								{query.isLoading && (
									<div className="space-y-2">
										{Array.from({ length: 5 }).map((_, i) => (
											<PremiumSkeleton
												key={i}
												variant="card"
												className="h-20"
												style={{ animationDelay: `${i * 50}ms` }}
											/>
										))}
									</div>
								)}

								{!query.isLoading && visibleCandidates.length === 0 && (
									<div className="flex flex-col items-center justify-center py-12 text-center border border-dashed border-border/50 rounded-xl">
										<FolderOpen className="h-10 w-10 text-muted-foreground/50 mb-3" />
										<p className="text-sm text-muted-foreground">
											No files match the current filters.
										</p>
									</div>
								)}

								{visibleCandidates.map((candidate, index) => {
									const selection = getSelectionForCandidate(selections, candidate);
									const selected = Boolean(selection);
									const episodeIds =
										selection && Array.isArray(selection.values.episodeIds)
											? selection.values.episodeIds
											: [];

									return (
										<div
											key={candidateKey(candidate)}
											className="animate-in fade-in slide-in-from-bottom-2"
											style={{
												animationDelay: `${index * 30}ms`,
												animationFillMode: "backwards",
											}}
										>
											<CandidateCard
												candidate={candidate}
												selected={selected}
												episodeIds={episodeIds}
												downloadId={downloadId}
												onToggle={() => handleToggleCandidate(candidate)}
												onToggleEpisode={(episodeId) => toggleEpisode(candidate, episodeId)}
												onSelectAllEpisodes={() => selectAllEpisodes(candidate)}
												onClearEpisodes={() => clearEpisodes(candidate)}
												disabled={isPending}
											/>
										</div>
									);
								})}
							</div>
						</>
					)}
				</div>

				{/* Footer */}
				<div className="shrink-0 p-6 border-t border-border/30 flex flex-wrap items-center justify-between gap-3">
					{reviewNavigation && (
						<div className="w-full space-y-2">
							<p className="text-sm font-medium" aria-live="polite">
								Download {reviewNavigation.position} of {reviewNavigation.total}
							</p>
							<p className="text-xs text-muted-foreground">
								Review each download separately. Navigation does not import files. Unsubmitted
								selections are cleared; submitted attempts are retained.
							</p>
							<div className="flex flex-wrap gap-2">
								<Button
									variant="outline"
									onClick={reviewNavigation.onPrevious}
									disabled={isPending || !reviewNavigation.onPrevious}
								>
									Previous download
								</Button>
								<Button
									variant="outline"
									onClick={reviewNavigation.onNext}
									disabled={isPending || !reviewNavigation.onNext}
								>
									Next download
								</Button>
							</div>
						</div>
					)}
					<p className="text-xs text-muted-foreground">
						{rejectionCount > 0 && "Some files may require manual mapping."}
					</p>
					<div className="flex flex-wrap items-center gap-3">
						{canReviewNewAttempt && (
							<Button
								type="button"
								variant="outline"
								onClick={() => void reviewNewAttempt()}
								disabled={isPending || isReviewing}
							>
								{isReviewing ? "Reviewing new attempt..." : "Review a new attempt"}
							</Button>
						)}
						{canReviewRemaining && (
							<Button
								type="button"
								variant="outline"
								onClick={() => void reviewRemaining()}
								disabled={isPending || isReviewing}
							>
								{isReviewing ? "Reviewing remaining files..." : "Review remaining files"}
							</Button>
						)}
						{(remainingReview || newAttemptReview) && (
							<Button
								type="button"
								variant="outline"
								disabled={isPending}
								onClick={() => {
									closeButtonRef.current?.focus();
									clear();
									cancelRemainingReview();
								}}
							>
								Back to progress
							</Button>
						)}
						{retryOriginalAllowed && (
							<Button
								variant="outline"
								onClick={() => void progress.refetch()}
								disabled={isPending || progress.isFetching}
							>
								Check progress
							</Button>
						)}
						<Button
							variant="outline"
							onClick={() => handleClose(false)}
							disabled={isPending}
							className="rounded-xl"
						>
							{attempt || observeOnly ? "Close" : "Cancel"}
						</Button>
						<Button
							onClick={handleSubmit}
							disabled={!ready || isPending || (!observeOnly && selectedCount === 0)}
							aria-busy={observeOnly && progress.isFetching}
							className="gap-2 rounded-xl font-medium"
							style={
								selectedCount > 0
									? {
											background: `linear-gradient(135deg, ${themeGradient.from}, ${themeGradient.to})`,
											boxShadow: `0 4px 12px -4px ${themeGradient.glow}`,
										}
									: undefined
							}
						>
							{isPending ? (
								<>
									<Loader2 data-icon="inline-start" className="animate-spin" />
									Requesting import...
								</>
							) : (
								<>
									<Download data-icon="inline-start" />
									{observeOnly
										? "Check progress"
										: retryOriginalAllowed
											? "Retry original request"
											: remainingReview
												? `Import ${selectedCount > 0 ? selectedCount + " " : ""}remaining selected`
												: `Import ${selectedCount > 0 ? `${selectedCount} ` : ""}selected`}
								</>
							)}
						</Button>
					</div>
				</div>
			</div>
		</div>
	);
};

export default ManualImportModal;
