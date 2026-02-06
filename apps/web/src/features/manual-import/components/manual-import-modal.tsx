"use client";

import { useCallback, useEffect, useMemo, useState } from "react";
import { useFocusTrap } from "../../../hooks/useFocusTrap";
import { X, Loader2, FolderOpen, Download, CheckSquare, XSquare, Filter, AlertTriangle } from "lucide-react";
import { PremiumSkeleton } from "../../../components/layout/premium-components";
import { Button } from "../../../components/ui/button";
import { SEMANTIC_COLORS, SERVICE_GRADIENTS } from "../../../lib/theme-gradients";
import { useThemeGradient } from "../../../hooks/useThemeGradient";
import { useManualImportQuery } from "../../../hooks/api/useManualImport";
import type { ManualImportModalProps, ManualImportCandidateUnion } from "../types";
import { candidateKey, describeRejections } from "../helpers";
import { useShallow } from "zustand/shallow";
import { useManualImportStore, getSelectionForCandidate } from "../store";
import { buildSubmissionDefaults } from "../lib/submission-builder";
import { useEpisodeSelection } from "../hooks/use-episode-selection";
import { useAutoSelection } from "../hooks/use-auto-selection";
import { useImportSubmission } from "../hooks/use-import-submission";
import { CandidateCard } from "./candidate-card";

const importModeOptions = [
	{ value: "auto", label: "Auto (match ARR settings)" },
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
}: ManualImportModalProps) => {
	const { gradient: themeGradient } = useThemeGradient();
	const serviceColor = SERVICE_COLORS[service] ?? themeGradient.from;
	const { selections, toggleSelection, clear } = useManualImportStore(
		useShallow((state) => ({
			selections: state.selections,
			toggleSelection: state.toggleSelection,
			clear: state.clear,
		})),
	);
	const focusTrapRef = useFocusTrap<HTMLDivElement>(open, () => onOpenChange(false));
	const [showSelectedOnly, setShowSelectedOnly] = useState(false);
	const [importMode, setImportMode] = useState<ImportMode>("auto");
	const [isFocused, setIsFocused] = useState(false);

	const query = useManualImportQuery({
		instanceId,
		service,
		downloadId,
		folder,
		enabled: open,
	});

	const candidates = query.candidates;

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

	const {
		submit,
		error: selectionError,
		setError: setSelectionError,
		isPending,
	} = useImportSubmission({
		instanceId,
		service,
		importMode,
		onSuccess: (importedCount) => {
			clear();
			onOpenChange(false);
			onCompleted?.({ status: "success", imported: importedCount });
		},
	});

	const rejectionCount = useMemo(
		() => candidates.filter((candidate) => Boolean(describeRejections(candidate))).length,
		[candidates],
	);

	const selectionsForService = useMemo(
		() => Object.values(selections).filter((selection) => selection.service === service),
		[selections, service],
	);

	const selectedCount = selectionsForService.length;

	useAutoSelection(
		open,
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
				className="relative w-full max-w-5xl max-h-[90vh] overflow-hidden rounded-2xl border border-border/50 bg-card/95 backdrop-blur-xl shadow-2xl animate-in zoom-in-95 slide-in-from-bottom-4 duration-300"
				style={{
					boxShadow: `0 25px 50px -12px rgba(0, 0, 0, 0.5), 0 0 0 1px ${serviceColor}15`,
				}}
				onClick={(event) => event.stopPropagation()}
			>
				{/* Close Button */}
				<button
					type="button"
					onClick={() => handleClose(false)}
					disabled={isPending}
					aria-label="Close modal"
					className="absolute right-4 top-4 z-10 flex h-8 w-8 items-center justify-center rounded-lg bg-black/50 text-white/70 transition-colors hover:bg-black/70 hover:text-white disabled:opacity-50"
				>
					<X className="h-4 w-4" />
				</button>

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
						<div>
							<h2 id="manual-import-title" className="text-xl font-bold text-foreground">
								Manual Import - {instanceName}
							</h2>
							<p className="text-sm text-muted-foreground">
								{downloadId
									? `Download: ${downloadId}`
									: folder
										? `Folder: ${folder}`
										: "Interactive manual import"}
							</p>
						</div>
					</div>
				</div>

				{/* Error Messages */}
				<div className="px-6 pt-4 space-y-3">
					{query.isError && (
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
								Failed to fetch manual import candidates.{" "}
								{query.error instanceof Error ? query.error.message : ""}
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
									disabled={isPending}
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
							<p className="text-sm text-muted-foreground">No files match the current filters.</p>
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

				{/* Footer */}
				<div className="p-6 border-t border-border/30 flex items-center justify-between">
					<p className="text-xs text-muted-foreground">
						{rejectionCount > 0 && "Some files may require manual mapping."}
					</p>
					<div className="flex items-center gap-3">
						<Button
							variant="outline"
							onClick={() => handleClose(false)}
							disabled={isPending}
							className="rounded-xl"
						>
							Cancel
						</Button>
						<Button
							onClick={handleSubmit}
							disabled={isPending || selectedCount === 0}
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
									<Loader2 className="h-4 w-4 animate-spin" />
									Importing...
								</>
							) : (
								<>
									<Download className="h-4 w-4" />
									Import {selectedCount > 0 ? `${selectedCount} ` : ""}selected
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
