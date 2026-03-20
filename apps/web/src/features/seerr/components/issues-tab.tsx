"use client";

import { SEERR_ISSUE_STATUS, type SeerrIssueType } from "@arr/shared";
import {
	AlertCircle,
	AlertTriangle,
	CheckCircle,
	Loader2,
	MessageSquare,
	Send,
} from "lucide-react";
import Image from "next/image";
import { useCallback, useEffect, useRef, useState } from "react";
import { toast } from "sonner";
import {
	FilterSelect,
	PremiumEmptyState,
	PremiumSkeleton,
	StatusBadge,
} from "../../../components/layout";
import { Button } from "../../../components/ui";
import {
	useAddSeerrIssueComment,
	useSeerrIssues,
	useUpdateSeerrIssueStatus,
} from "../../../hooks/api/useSeerr";
import { getLinuxIsoName, getLinuxUsername, useIncognitoMode } from "../../../lib/incognito";
import { SEMANTIC_COLORS, SERVICE_GRADIENTS } from "../../../lib/theme-gradients";
import {
	formatRelativeTime,
	getIssueStatusLabel,
	getIssueStatusVariant,
	getIssueTypeLabel,
	getPosterUrl,
} from "../lib/seerr-utils";

type IssueFilter = "all" | "open" | "resolved";
type IssueSort = "added" | "modified";
type IssueTypeFilter = "all" | "1" | "2" | "3" | "4";

const FILTER_OPTIONS: { value: IssueFilter; label: string }[] = [
	{ value: "all", label: "All Issues" },
	{ value: "open", label: "Open" },
	{ value: "resolved", label: "Resolved" },
];

const SORT_OPTIONS: { value: IssueSort; label: string }[] = [
	{ value: "added", label: "Newest" },
	{ value: "modified", label: "Last Updated" },
];

const TYPE_FILTER_OPTIONS: { value: IssueTypeFilter; label: string }[] = [
	{ value: "all", label: "All Types" },
	{ value: "1", label: "Video" },
	{ value: "2", label: "Audio" },
	{ value: "3", label: "Subtitle" },
	{ value: "4", label: "Other" },
];

const SEERR_GRADIENT = SERVICE_GRADIENTS.seerr;

function getIssueAccentColor(status: number): { from: string; to: string } {
	if (status === SEERR_ISSUE_STATUS.OPEN) {
		return { from: SEMANTIC_COLORS.warning.from, to: SEMANTIC_COLORS.warning.to };
	}
	return { from: SEMANTIC_COLORS.success.from, to: SEMANTIC_COLORS.success.to };
}

function formatProblemLocation(problemSeason: number, problemEpisode: number): string | null {
	if (problemSeason === 0 && problemEpisode === 0) return null;
	if (problemEpisode === 0) return `S${String(problemSeason).padStart(2, "0")}`;
	return `S${String(problemSeason).padStart(2, "0")}E${String(problemEpisode).padStart(2, "0")}`;
}

interface IssuesTabProps {
	instanceId: string;
}

export const IssuesTab = ({ instanceId }: IssuesTabProps) => {
	const [incognitoMode] = useIncognitoMode();
	const PAGE_SIZE = 50;
	const [filter, setFilter] = useState<IssueFilter>("open");
	const [sort, setSort] = useState<IssueSort>("added");
	const [typeFilter, setTypeFilter] = useState<IssueTypeFilter>("all");
	const [take, setTake] = useState(PAGE_SIZE);
	const { data, isLoading, isFetching, isError } = useSeerrIssues({
		instanceId,
		filter,
		sort,
		take,
	});

	// Reset pagination when filters change
	const prevRef = useRef({ filter, sort, typeFilter });
	useEffect(() => {
		if (
			prevRef.current.filter !== filter ||
			prevRef.current.sort !== sort ||
			prevRef.current.typeFilter !== typeFilter
		) {
			setTake(PAGE_SIZE);
			prevRef.current = { filter, sort, typeFilter };
		}
	}, [filter, sort, typeFilter]);

	const totalResults = data?.pageInfo.results ?? 0;
	const hasMore = (data?.results.length ?? 0) < totalResults;
	const handleLoadMore = useCallback(() => setTake((prev) => prev + PAGE_SIZE), []);
	const updateStatusMutation = useUpdateSeerrIssueStatus();
	const addCommentMutation = useAddSeerrIssueComment();
	const [commentInput, setCommentInput] = useState<Record<number, string>>({});

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
				title="Failed to Load Issues"
				description="Could not connect to the Seerr instance. Check your configuration in Settings."
			/>
		);
	}

	const allIssues = data?.results ?? [];
	const issues =
		typeFilter === "all"
			? allIssues
			: allIssues.filter((i) => i.issueType === (Number(typeFilter) as SeerrIssueType));

	const handleSubmitComment = (issueId: number) => {
		const message = commentInput[issueId]?.trim();
		if (!message) return;
		addCommentMutation.mutate(
			{ instanceId, issueId, message },
			{
				onSuccess: () => toast.success("Comment added"),
				onError: () => toast.error("Failed to add comment"),
			},
		);
		setCommentInput((prev) => ({ ...prev, [issueId]: "" }));
	};

	return (
		<div className="space-y-4">
			<div className="flex flex-wrap items-center justify-between gap-3">
				<p className="text-sm text-muted-foreground">
					{issues.length === allIssues.length
						? `${totalResults} total issues`
						: `${issues.length} of ${totalResults} issues`}
				</p>
				<div className="flex items-center gap-2">
					<FilterSelect
						value={sort}
						onChange={(v) => setSort(v as IssueSort)}
						options={SORT_OPTIONS}
						className="min-w-[120px]"
					/>
					<FilterSelect
						value={typeFilter}
						onChange={(v) => setTypeFilter(v as IssueTypeFilter)}
						options={TYPE_FILTER_OPTIONS}
						className="min-w-[110px]"
					/>
					<FilterSelect
						value={filter}
						onChange={(v) => setFilter(v as IssueFilter)}
						options={FILTER_OPTIONS}
						className="min-w-[120px]"
					/>
				</div>
			</div>

			{issues.length === 0 ? (
				<PremiumEmptyState
					icon={AlertTriangle}
					title="No Issues"
					description={`No ${filter === "all" ? "" : filter + " "}issues found.`}
				/>
			) : (
				<div className="space-y-3">
					{issues.map((issue, index) => {
						const posterUrl = getPosterUrl(issue.media.posterPath);
						const problemLocation = formatProblemLocation(
							issue.problemSeason,
							issue.problemEpisode,
						);
						const accent = getIssueAccentColor(issue.status);

						return (
							<div
								key={issue.id}
								className="group relative rounded-xl overflow-hidden transition-all duration-200 hover:-translate-y-[1px] hover:shadow-lg hover:shadow-black/10 animate-in fade-in slide-in-from-bottom-1 duration-300"
								style={{
									border: `1px solid ${accent.from}10`,
									animationDelay: `${index * 50}ms`,
									animationFillMode: "backwards",
								}}
							>
								{/* Background gradient */}
								<div
									className="absolute inset-0 pointer-events-none"
									style={{
										background: `linear-gradient(135deg, ${accent.from}05, transparent 60%)`,
									}}
								/>

								{/* Hover glow */}
								<div
									className="absolute inset-0 pointer-events-none opacity-0 group-hover:opacity-100 transition-opacity duration-200"
									style={{
										background: `radial-gradient(ellipse at top left, ${accent.from}06, transparent 50%)`,
									}}
								/>

								{/* Accent bar */}
								<div
									className="absolute left-0 top-0 bottom-0 w-[3px]"
									style={{
										background: `linear-gradient(180deg, ${accent.from}, ${accent.to}70)`,
									}}
								/>

								<div className="relative flex items-start gap-4 py-3.5 pl-5 pr-4">
									{/* Poster */}
									<div
										className="flex h-14 w-10 shrink-0 items-center justify-center overflow-hidden rounded-md ring-1 ring-white/[0.06]"
										style={{
											boxShadow: posterUrl
												? `0 2px 8px ${SEERR_GRADIENT.from}10, 0 4px 12px rgba(0,0,0,0.2)`
												: undefined,
											backgroundColor: posterUrl ? undefined : "rgba(255,255,255,0.04)",
										}}
									>
										{posterUrl && !incognitoMode ? (
											<Image
												src={posterUrl}
												alt={issue.media.title ?? "Media"}
												width={40}
												height={56}
												className="h-full w-full object-cover"
											/>
										) : (
											<AlertTriangle className="h-4 w-4 text-muted-foreground/40" />
										)}
									</div>

									{/* Content */}
									<div className="min-w-0 flex-1">
										{/* Top row: type pill + metadata */}
										<div className="flex items-center gap-2 mb-1">
											<span
												className="inline-flex items-center gap-1 rounded-md px-1.5 py-0.5 text-[10px] font-semibold uppercase tracking-wider shrink-0"
												style={{
													backgroundColor: `${SEERR_GRADIENT.from}12`,
													color: SEERR_GRADIENT.from,
												}}
											>
												{getIssueTypeLabel(issue.issueType)}
											</span>
											{problemLocation && (
												<span
													className="rounded-md px-1.5 py-0.5 text-[10px] font-mono font-bold"
													style={{
														backgroundColor: `${SEERR_GRADIENT.from}12`,
														color: SEERR_GRADIENT.from,
													}}
												>
													{problemLocation}
												</span>
											)}
											<span className="text-[11px] text-muted-foreground/40">
												by {incognitoMode ? getLinuxUsername(issue.createdBy.displayName) : issue.createdBy.displayName}
											</span>
											<span className="text-[11px] text-muted-foreground/40">
												{formatRelativeTime(issue.createdAt)}
											</span>
											{issue.comments.length > 0 && (
												<span className="inline-flex items-center gap-1 text-[11px] text-muted-foreground/40">
													<MessageSquare className="h-3 w-3" />
													{issue.comments.length}
												</span>
											)}
										</div>

										{/* Title + status */}
										<div className="flex items-center gap-2 flex-wrap">
											<h3 className="truncate text-[14px] font-semibold text-foreground leading-snug">
												{incognitoMode ? getLinuxIsoName(issue.media.title ?? `Issue #${issue.id}`) : (issue.media.title ?? `Issue #${issue.id}`)}
											</h3>
											<StatusBadge status={getIssueStatusVariant(issue.status)}>
												{getIssueStatusLabel(issue.status)}
											</StatusBadge>
										</div>

										{/* Existing comments */}
										{issue.comments.length > 0 && (
											<div className="mt-2 space-y-1.5 border-l-2 border-border/20 pl-3">
												{issue.comments.map((comment) => (
													<div key={comment.id} className="text-xs">
														<span className="font-medium text-foreground">
															{incognitoMode ? getLinuxUsername(comment.user.displayName) : comment.user.displayName}
														</span>
														<span className="ml-1.5 text-muted-foreground/40">
															{formatRelativeTime(comment.createdAt)}
														</span>
														<p className="mt-0.5 text-muted-foreground/50">{comment.message}</p>
													</div>
												))}
											</div>
										)}

										{/* Comment input for open issues */}
										{issue.status === SEERR_ISSUE_STATUS.OPEN && (
											<div className="mt-2 flex items-center gap-2">
												<input
													type="text"
													placeholder="Add a comment..."
													value={commentInput[issue.id] ?? ""}
													onChange={(e) =>
														setCommentInput((prev) => ({ ...prev, [issue.id]: e.target.value }))
													}
													className="h-7 flex-1 rounded-md border border-border/30 bg-white/[0.03] px-2 text-xs text-foreground placeholder:text-muted-foreground/30 focus:outline-hidden focus:border-border/50"
													onKeyDown={(e) => {
														if (e.key === "Enter") handleSubmitComment(issue.id);
													}}
												/>
												<button
													type="button"
													onClick={() => handleSubmitComment(issue.id)}
													disabled={
														!commentInput[issue.id]?.trim() || addCommentMutation.isPending
													}
													className="flex h-7 w-7 shrink-0 items-center justify-center rounded-md border border-border/30 bg-white/[0.03] text-muted-foreground/40 transition-colors hover:bg-white/[0.06] hover:text-foreground disabled:opacity-40 disabled:pointer-events-none"
													title="Send comment"
												>
													<Send className="h-3 w-3" />
												</button>
											</div>
										)}
									</div>

									{/* Resolve/reopen button — hover reveal */}
									<div className="shrink-0 opacity-0 group-hover:opacity-100 transition-opacity duration-200">
										{issue.status === SEERR_ISSUE_STATUS.OPEN ? (
											<Button
												variant="secondary"
												size="sm"
												disabled={updateStatusMutation.isPending}
												onClick={() =>
													updateStatusMutation.mutate(
														{ instanceId, issueId: issue.id, status: "resolved" },
														{
															onSuccess: () => toast.success("Issue resolved"),
															onError: () => toast.error("Failed to resolve issue"),
														},
													)
												}
												className="gap-1.5 border-border/50 bg-card/50 text-xs"
											>
												<CheckCircle className="h-3 w-3" />
												Resolve
											</Button>
										) : (
											<Button
												variant="secondary"
												size="sm"
												disabled={updateStatusMutation.isPending}
												onClick={() =>
													updateStatusMutation.mutate(
														{ instanceId, issueId: issue.id, status: "open" },
														{
															onSuccess: () => toast.success("Issue reopened"),
															onError: () => toast.error("Failed to reopen issue"),
														},
													)
												}
												className="gap-1.5 border-border/50 bg-card/50 text-xs"
											>
												Reopen
											</Button>
										)}
									</div>
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
								Load More ({totalResults - allIssues.length} remaining)
							</Button>
						</div>
					)}
				</div>
			)}
		</div>
	);
};
