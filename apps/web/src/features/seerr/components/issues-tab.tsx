"use client";

import { useState } from "react";
import { AlertCircle, AlertTriangle, CheckCircle, MessageSquare } from "lucide-react";
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
import { SEERR_ISSUE_STATUS } from "@arr/shared";

type IssueFilter = "all" | "open" | "resolved";

const FILTER_OPTIONS: { value: IssueFilter; label: string }[] = [
	{ value: "all", label: "All Issues" },
	{ value: "open", label: "Open" },
	{ value: "resolved", label: "Resolved" },
];

interface IssuesTabProps {
	instanceId: string;
}

export const IssuesTab = ({ instanceId }: IssuesTabProps) => {
	const [filter, setFilter] = useState<IssueFilter>("open");
	const { data, isLoading, isError } = useSeerrIssues({ instanceId, filter, take: 50 });
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

	const issues = data?.results ?? [];

	return (
		<div className="space-y-4">
			<div className="flex items-center justify-between">
				<p className="text-sm text-muted-foreground">{data?.pageInfo.results ?? 0} total issues</p>
				<FilterSelect
					value={filter}
					onChange={(v) => setFilter(v as IssueFilter)}
					options={FILTER_OPTIONS}
					className="min-w-[120px]"
				/>
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
												<img
													src={posterUrl}
													alt={issue.media.title ?? "Media"}
													className="h-full w-full object-cover"
												/>
											) : (
												<AlertTriangle className="h-4 w-4 text-muted-foreground" />
											)}
										</div>

										{/* Content */}
										<div className="min-w-0 flex-1">
											<div className="flex items-center gap-2">
												<h3 className="truncate text-sm font-semibold text-foreground">
													{issue.media.title ?? `Issue #${issue.id}`}
												</h3>
												<StatusBadge status={getIssueStatusVariant(issue.status)}>
													{getIssueStatusLabel(issue.status)}
												</StatusBadge>
											</div>
											<div className="mt-1 flex items-center gap-3 text-xs text-muted-foreground">
												<span>{getIssueTypeLabel(issue.issueType)}</span>
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
															if (e.key === "Enter" && commentInput[issue.id]?.trim()) {
																addCommentMutation.mutate(
																	{
																		instanceId,
																		issueId: issue.id,
																		message: commentInput[issue.id]!.trim(),
																	},
																	{
																		onSuccess: () => toast.success("Comment added"),
																		onError: () => toast.error("Failed to add comment"),
																	},
																);
																setCommentInput((prev) => ({ ...prev, [issue.id]: "" }));
															}
														}}
													/>
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
				</div>
			)}
		</div>
	);
};
