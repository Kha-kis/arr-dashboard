"use client";

import { useState, useCallback, useEffect, useRef } from "react";
import Image from "next/image";
import { AlertCircle, AlertTriangle, CheckCircle, MessageSquare, Loader2, Send } from "lucide-react";
import { toast } from "sonner";
import {
	FilterSelect,
	GlassmorphicCard,
	StatusBadge,
	PremiumEmptyState,
	PremiumSkeleton,
} from "../../../components/layout";
import { Button } from "../../../components/ui";
import {
	useSeerrIssues,
	useUpdateSeerrIssueStatus,
	useAddSeerrIssueComment,
} from "../../../hooks/api/useSeerr";
import {
	getIssueTypeLabel,
	getIssueStatusLabel,
	getIssueStatusVariant,
	formatRelativeTime,
	getPosterUrl,
} from "../lib/seerr-utils";
import { SEERR_ISSUE_STATUS, type SeerrIssueType } from "@arr/shared";

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

function formatProblemLocation(problemSeason: number, problemEpisode: number): string | null {
	if (problemSeason === 0 && problemEpisode === 0) return null;
	if (problemEpisode === 0) return `S${String(problemSeason).padStart(2, "0")}`;
	return `S${String(problemSeason).padStart(2, "0")}E${String(problemEpisode).padStart(2, "0")}`;
}

interface IssuesTabProps {
	instanceId: string;
}

export const IssuesTab = ({ instanceId }: IssuesTabProps) => {
	const PAGE_SIZE = 50;
	const [filter, setFilter] = useState<IssueFilter>("open");
	const [sort, setSort] = useState<IssueSort>("added");
	const [typeFilter, setTypeFilter] = useState<IssueTypeFilter>("all");
	const [take, setTake] = useState(PAGE_SIZE);
	const { data, isLoading, isFetching, isError } = useSeerrIssues({ instanceId, filter, sort, take });

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
						const problemLocation = formatProblemLocation(issue.problemSeason, issue.problemEpisode);

						return (
							<div
								key={issue.id}
								className="animate-in fade-in slide-in-from-bottom-2 duration-300"
								style={{ animationDelay: `${index * 30}ms`, animationFillMode: "backwards" }}
							>
								<GlassmorphicCard padding="md">
									<div className="flex items-start gap-4">
										{/* Poster */}
										<div className="flex h-14 w-10 shrink-0 items-center justify-center overflow-hidden rounded-md bg-muted/30">
											{posterUrl ? (
												<Image
													src={posterUrl}
													alt={issue.media.title ?? "Media"}
													width={40}
													height={56}
													className="h-full w-full object-cover"
												/>
											) : (
												<AlertTriangle className="h-4 w-4 text-muted-foreground" />
											)}
										</div>

										{/* Content */}
										<div className="min-w-0 flex-1">
											<div className="flex items-center gap-2 flex-wrap">
												<h3 className="truncate text-sm font-semibold text-foreground">
													{issue.media.title ?? `Issue #${issue.id}`}
												</h3>
												<StatusBadge status={getIssueStatusVariant(issue.status)}>
													{getIssueStatusLabel(issue.status)}
												</StatusBadge>
											</div>
											<div className="mt-1 flex items-center gap-3 text-xs text-muted-foreground flex-wrap">
												<span>{getIssueTypeLabel(issue.issueType)}</span>
												{problemLocation && (
													<span className="rounded-md bg-muted/30 px-1.5 py-0.5 text-[10px] font-medium text-foreground">
														{problemLocation}
													</span>
												)}
												<span>by {issue.createdBy.displayName}</span>
												<span>{formatRelativeTime(issue.createdAt)}</span>
												{issue.comments.length > 0 && (
													<span className="flex items-center gap-1">
														<MessageSquare className="h-3 w-3" />
														{issue.comments.length}
													</span>
												)}
											</div>

											{/* Existing comments */}
											{issue.comments.length > 0 && (
												<div className="mt-2 space-y-1.5 border-l-2 border-border/30 pl-3">
													{issue.comments.map((comment) => (
														<div key={comment.id} className="text-xs">
															<span className="font-medium text-foreground">
																{comment.user.displayName}
															</span>
															<span className="ml-1.5 text-muted-foreground">
																{formatRelativeTime(comment.createdAt)}
															</span>
															<p className="mt-0.5 text-muted-foreground">{comment.message}</p>
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
														className="h-7 flex-1 rounded-md border border-border/50 bg-card/30 px-2 text-xs text-foreground placeholder:text-muted-foreground focus:outline-hidden"
														onKeyDown={(e) => {
															if (e.key === "Enter") handleSubmitComment(issue.id);
														}}
													/>
													<button
														type="button"
														onClick={() => handleSubmitComment(issue.id)}
														disabled={!commentInput[issue.id]?.trim() || addCommentMutation.isPending}
														className="flex h-7 w-7 shrink-0 items-center justify-center rounded-md border border-border/50 bg-card/30 text-muted-foreground transition-colors hover:bg-card/60 hover:text-foreground disabled:opacity-40 disabled:pointer-events-none"
														title="Send comment"
													>
														<Send className="h-3 w-3" />
													</button>
												</div>
											)}
										</div>

										{/* Resolve/reopen button */}
										<div className="shrink-0">
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
								</GlassmorphicCard>
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
