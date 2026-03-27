"use client";

import type { SeerrMediaStatus, SeerrRequest, SeerrSeason } from "@arr/shared";
import { SEERR_MEDIA_STATUS, SEERR_MEDIA_STATUS_LABEL } from "@arr/shared";
import { AlertCircle, Check, Eye, EyeOff, ExternalLink, Loader2, Trash2, X } from "lucide-react";
import { useCallback, useEffect, useMemo, useState } from "react";
import { toast } from "sonner";
import {
	FilterSelect,
	GradientButton,
	PremiumEmptyState,
	PremiumSkeleton,
} from "../../../components/layout";
import { Button } from "../../../components/ui";
import {
	useApproveSeerrRequest,
	useBulkSeerrRequestAction,
	useDeclineSeerrRequest,
	useDeleteSeerrRequest,
	useSeerrRequests,
} from "../../../hooks/api/useSeerr";
import { useThemeGradient } from "../../../hooks/useThemeGradient";
import { getLinuxUsername, useIncognitoMode } from "../../../lib/incognito";
import { RequestCard } from "./request-card";
import { RequestStatusTimeline } from "./request-status-timeline";

type RequestSort = "added" | "modified";

const SORT_OPTIONS: { value: RequestSort; label: string }[] = [
	{ value: "added", label: "Newest" },
	{ value: "modified", label: "Last Updated" },
];

interface ApprovalQueueTabProps {
	instanceId: string;
	onSelectRequest?: (request: SeerrRequest) => void;
}

const PAGE_SIZE = 50;

export const ApprovalQueueTab = ({ instanceId, onSelectRequest }: ApprovalQueueTabProps) => {
	const { gradient: themeGradient } = useThemeGradient();
	const [incognitoMode] = useIncognitoMode();
	const [sort, setSort] = useState<RequestSort>("added");
	const [take, setTake] = useState(PAGE_SIZE);
	const [selectedIds, setSelectedIds] = useState<Set<number>>(new Set());
	const [previewId, setPreviewId] = useState<number | null>(null);
	const { data, isLoading, isFetching, isError } = useSeerrRequests({
		instanceId,
		filter: "pending",
		sort,
		take,
	});
	const totalResults = data?.pageInfo.results ?? 0;
	const hasMore = (data?.results.length ?? 0) < totalResults;
	const handleLoadMore = useCallback(() => setTake((prev) => prev + PAGE_SIZE), []);
	const approveMutation = useApproveSeerrRequest();
	const declineMutation = useDeclineSeerrRequest();
	const deleteMutation = useDeleteSeerrRequest();
	const bulkMutation = useBulkSeerrRequestAction();
	const [confirmingDeclineId, setConfirmingDeclineId] = useState<number | null>(null);
	const [confirmingDeleteId, setConfirmingDeleteId] = useState<number | null>(null);

	const requests = useMemo(() => data?.results ?? [], [data?.results]);
	const allSelected = requests.length > 0 && requests.every((r) => selectedIds.has(r.id));

	const toggleSelect = useCallback((id: number) => {
		setSelectedIds((prev) => {
			const next = new Set(prev);
			if (next.has(id)) {
				next.delete(id);
			} else {
				next.add(id);
			}
			return next;
		});
	}, []);

	const toggleSelectAll = useCallback(() => {
		if (allSelected) {
			setSelectedIds(new Set());
		} else {
			setSelectedIds(new Set(requests.map((r) => r.id)));
		}
	}, [allSelected, requests]);

	const handleBulkAction = useCallback(
		(action: "approve" | "decline" | "delete") => {
			const ids = [...selectedIds];
			bulkMutation.mutate(
				{ instanceId, action, requestIds: ids },
				{
					onSuccess: (result) => {
						setSelectedIds(new Set());
						if (result.totalFailed === 0) {
							toast.success(
								`${action === "approve" ? "Approved" : action === "decline" ? "Declined" : "Deleted"} ${result.totalSuccess} request${result.totalSuccess !== 1 ? "s" : ""}`,
							);
						} else {
							toast.warning(`${result.totalSuccess} succeeded, ${result.totalFailed} failed`);
						}
					},
					onError: () => toast.error(`Failed to ${action} requests`),
				},
			);
		},
		[instanceId, selectedIds, bulkMutation],
	);

	const [confirmBulkAction, setConfirmBulkAction] = useState<"decline" | "delete" | null>(null);

	useEffect(() => {
		if (!confirmBulkAction) return;
		const timer = setTimeout(() => setConfirmBulkAction(null), 3000);
		return () => clearTimeout(timer);
	}, [confirmBulkAction]);

	const handleBulkDestructive = useCallback(
		(action: "decline" | "delete") => {
			if (confirmBulkAction === action) {
				handleBulkAction(action);
				setConfirmBulkAction(null);
			} else {
				setConfirmBulkAction(action);
			}
		},
		[confirmBulkAction, handleBulkAction],
	);

	const togglePreview = useCallback((id: number) => {
		setPreviewId((prev) => (prev === id ? null : id));
	}, []);

	if (isLoading) {
		return (
			<div className="space-y-3">
				{Array.from({ length: 3 }).map((_, i) => (
					<PremiumSkeleton key={i} className="h-24 w-full rounded-xl" />
				))}
			</div>
		);
	}

	if (isError) {
		return (
			<PremiumEmptyState
				icon={AlertCircle}
				title="Failed to Load Requests"
				description="Could not connect to the Seerr instance. Check your configuration in Settings."
			/>
		);
	}

	if (requests.length === 0) {
		return (
			<PremiumEmptyState
				icon={Check}
				title="No Pending Requests"
				description="All caught up! New requests will appear here when users submit them."
			/>
		);
	}

	return (
		<div className="space-y-3">
			<div className="flex items-center justify-between">
				<div className="flex items-center gap-3">
					<label className="flex items-center gap-2 cursor-pointer">
						<input
							type="checkbox"
							checked={allSelected}
							onChange={toggleSelectAll}
							className="h-4 w-4 rounded border-border/50 accent-current"
							style={{ accentColor: themeGradient.from }}
						/>
						<span className="text-xs text-muted-foreground">Select All</span>
					</label>
					<p className="text-sm text-muted-foreground">
						{totalResults} pending request{totalResults !== 1 ? "s" : ""}
					</p>
				</div>
				<FilterSelect
					label="Sort"
					value={sort}
					onChange={(v) => setSort(v as RequestSort)}
					options={SORT_OPTIONS}
					className="min-w-[120px]"
				/>
			</div>
			{requests.map((request, index) => {
				const isPreviewing = previewId === request.id;
				return (
					<div key={request.id} className="flex items-start gap-3">
						<label className="flex items-center pt-4 cursor-pointer shrink-0">
							<input
								type="checkbox"
								checked={selectedIds.has(request.id)}
								onChange={() => toggleSelect(request.id)}
								aria-label={`Select request for ${request.media.title ?? `item #${request.id}`}`}
								className="h-4 w-4 rounded border-border/50"
								style={{ accentColor: themeGradient.from }}
							/>
						</label>
						<div className="flex-1 min-w-0">
							<RequestCard
								request={request}
								instanceId={instanceId}
								index={index}
								onClick={() => onSelectRequest?.(request)}
								actions={
									<>
										<Button
											variant="secondary"
											size="sm"
											onClick={() => togglePreview(request.id)}
											aria-label={isPreviewing ? "Close preview" : "Preview request"}
											aria-expanded={isPreviewing}
											aria-controls={isPreviewing ? `preview-${request.id}` : undefined}
											className="gap-1.5 border-border/50 bg-card/50 text-xs"
										>
											{isPreviewing ? <EyeOff className="h-3 w-3" /> : <Eye className="h-3 w-3" />}
											<span className="hidden sm:inline">Preview</span>
										</Button>
										<GradientButton
											size="sm"
											icon={Check}
											disabled={approveMutation.isPending}
											onClick={() =>
												approveMutation.mutate(
													{ instanceId, requestId: request.id },
													{
														onSuccess: () => toast.success("Request approved"),
														onError: () => toast.error("Failed to approve request"),
													},
												)
											}
										>
											Approve
										</GradientButton>
										{confirmingDeclineId === request.id ? (
											<>
												<Button
													variant="destructive"
													size="sm"
													disabled={declineMutation.isPending}
													onClick={() => {
														declineMutation.mutate(
															{ instanceId, requestId: request.id },
															{
																onSuccess: () => toast.success("Request declined"),
																onError: () => toast.error("Failed to decline request"),
															},
														);
														setConfirmingDeclineId(null);
													}}
													className="gap-1.5 text-xs"
												>
													Confirm
												</Button>
												<Button
													variant="secondary"
													size="sm"
													onClick={() => setConfirmingDeclineId(null)}
													className="gap-1.5 border-border/50 bg-card/50 text-xs"
												>
													Cancel
												</Button>
											</>
										) : (
											<Button
												variant="secondary"
												size="sm"
												disabled={declineMutation.isPending}
												onClick={() => setConfirmingDeclineId(request.id)}
												className="gap-1.5 border-border/50 bg-card/50"
											>
												<X className="h-3.5 w-3.5" />
												Decline
											</Button>
										)}
										{confirmingDeleteId === request.id ? (
											<>
												<Button
													variant="destructive"
													size="sm"
													disabled={deleteMutation.isPending}
													onClick={() => {
														deleteMutation.mutate(
															{ instanceId, requestId: request.id },
															{
																onSuccess: () => toast.success("Request deleted"),
																onError: () => toast.error("Failed to delete request"),
															},
														);
														setConfirmingDeleteId(null);
													}}
													className="gap-1.5 text-xs"
												>
													Confirm
												</Button>
												<Button
													variant="secondary"
													size="sm"
													onClick={() => setConfirmingDeleteId(null)}
													className="gap-1.5 border-border/50 bg-card/50 text-xs"
												>
													Cancel
												</Button>
											</>
										) : (
											<Button
												variant="secondary"
												size="sm"
												disabled={deleteMutation.isPending}
												onClick={() => setConfirmingDeleteId(request.id)}
												className="gap-1.5 border-border/50 bg-card/50"
											>
												<Trash2 className="h-3 w-3" />
											</Button>
										)}
									</>
								}
							/>

							{/* Inline preview panel */}
							{isPreviewing && (
								<InlinePreviewPanel
									request={request}
									incognitoMode={incognitoMode}
									onOpenDetails={() => onSelectRequest?.(request)}
								/>
							)}
						</div>
					</div>
				);
			})}

			{hasMore && (
				<div className="flex justify-center pt-2">
					<Button
						variant="secondary"
						onClick={handleLoadMore}
						disabled={isFetching}
						className="gap-2 border-border/50 bg-card/50 text-xs"
					>
						{isFetching ? <Loader2 className="h-3 w-3 animate-spin" /> : null}
						Load More ({totalResults - requests.length} remaining)
					</Button>
				</div>
			)}

			{/* Bulk action bar */}
			{selectedIds.size > 0 && (
				<div
					className="z-sticky sticky bottom-4 flex items-center justify-between gap-4 rounded-xl border border-border/50 bg-card/90 px-4 py-3 backdrop-blur-md animate-in fade-in slide-in-from-bottom-2 duration-200"
					style={{
						boxShadow: `0 -4px 20px ${themeGradient.from}10`,
					}}
				>
					<span className="text-sm font-medium text-muted-foreground">
						{selectedIds.size} selected
					</span>
					<div className="flex items-center gap-2">
						<GradientButton
							size="sm"
							icon={Check}
							disabled={bulkMutation.isPending}
							onClick={() => handleBulkAction("approve")}
						>
							{bulkMutation.isPending ? "Processing..." : "Approve All"}
						</GradientButton>
						<Button
							variant="secondary"
							size="sm"
							disabled={bulkMutation.isPending}
							onClick={() => handleBulkDestructive("decline")}
							className={`gap-1.5 border-border/50 bg-card/50 ${confirmBulkAction === "decline" ? "text-red-400 border-red-400/50" : ""}`}
						>
							{confirmBulkAction === "decline" ? (
								<span className="text-xs font-medium">Confirm decline {selectedIds.size}?</span>
							) : (
								<>
									<X className="h-3.5 w-3.5" />
									Decline All
								</>
							)}
						</Button>
						<Button
							variant="secondary"
							size="sm"
							disabled={bulkMutation.isPending}
							onClick={() => handleBulkDestructive("delete")}
							className={`gap-1.5 border-border/50 bg-card/50 ${confirmBulkAction === "delete" ? "text-red-400 border-red-400/50" : "text-red-400 hover:text-red-300"}`}
						>
							{confirmBulkAction === "delete" ? (
								<span className="text-xs font-medium">Confirm delete {selectedIds.size}?</span>
							) : (
								<>
									<Trash2 className="h-3 w-3" />
									Delete All
								</>
							)}
						</Button>
					</div>
				</div>
			)}
		</div>
	);
};

// ============================================================================
// Inline Preview Panel
// ============================================================================

function getSeasonStatusColor(status: SeerrMediaStatus): string {
	switch (status) {
		case SEERR_MEDIA_STATUS.AVAILABLE:
			return "bg-emerald-400";
		case SEERR_MEDIA_STATUS.PARTIALLY_AVAILABLE:
			return "bg-sky-400";
		case SEERR_MEDIA_STATUS.PROCESSING:
			return "bg-amber-400";
		case SEERR_MEDIA_STATUS.PENDING:
			return "bg-amber-400/60";
		default:
			return "bg-muted-foreground/40";
	}
}

function SeasonDetail({ seasons }: { seasons: SeerrSeason[] }) {
	return (
		<div className="space-y-1.5">
			<h4 className="text-[11px] font-semibold uppercase tracking-wider text-muted-foreground">
				Seasons
			</h4>
			<div className="flex flex-wrap gap-1.5">
				{seasons.map((s) => {
					const statusLabel =
						SEERR_MEDIA_STATUS_LABEL[s.status as keyof typeof SEERR_MEDIA_STATUS_LABEL] ??
						"Unknown";
					return (
						<span
							key={s.seasonNumber}
							className="inline-flex items-center gap-1.5 rounded-md border border-border/40 bg-card/40 px-2 py-1 text-[11px] text-muted-foreground"
						>
							<span
								className={`inline-block h-2 w-2 shrink-0 rounded-full ${getSeasonStatusColor(s.status)}`}
								role="img"
								aria-label={`Season ${s.seasonNumber}: ${statusLabel}`}
								title={`S${s.seasonNumber}: ${statusLabel}`}
							/>
							S{s.seasonNumber}
							<span className="text-muted-foreground/50">{statusLabel}</span>
						</span>
					);
				})}
			</div>
		</div>
	);
}

interface InlinePreviewPanelProps {
	request: SeerrRequest;
	incognitoMode: boolean;
	onOpenDetails?: () => void;
}

function InlinePreviewPanel({ request, incognitoMode, onOpenDetails }: InlinePreviewPanelProps) {
	const hasOverview = !incognitoMode && !!request.media.overview;
	const hasSeasons = request.type === "tv" && !!request.seasons && request.seasons.length > 0;

	return (
		<div
			id={`preview-${request.id}`}
			className="mt-1 rounded-xl border border-border/30 bg-card/20 backdrop-blur-xs p-4 space-y-4 animate-in fade-in slide-in-from-top-1 duration-200"
		>
			{/* Expanded timeline */}
			<RequestStatusTimeline
				request={request}
				variant="expanded"
				modifierName={
					request.modifiedBy
						? incognitoMode
							? getLinuxUsername(request.modifiedBy.displayName)
							: request.modifiedBy.displayName
						: undefined
				}
			/>

			{/* Overview */}
			{hasOverview && (
				<div className="space-y-1.5">
					<h4 className="text-[11px] font-semibold uppercase tracking-wider text-muted-foreground">
						Overview
					</h4>
					<p className="text-[12px] leading-relaxed text-foreground/70 line-clamp-3">
						{request.media.overview}
					</p>
				</div>
			)}

			{/* Season detail (TV only) */}
			{hasSeasons && <SeasonDetail seasons={request.seasons!} />}

			{/* Details button — opens full modal */}
			{onOpenDetails && (
				<div className="flex items-center pt-1">
					<Button
						variant="secondary"
						size="sm"
						onClick={onOpenDetails}
						className="gap-1.5 border-border/50 bg-card/50 text-xs"
					>
						<ExternalLink className="h-3 w-3" />
						Full Details
					</Button>
				</div>
			)}
		</div>
	);
}
