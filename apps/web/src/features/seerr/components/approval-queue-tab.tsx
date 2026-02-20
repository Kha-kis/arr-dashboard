"use client";

import { useState, useCallback } from "react";
import { AlertCircle, Check, X, Loader2, Trash2 } from "lucide-react";
import { toast } from "sonner";
import { FilterSelect, GradientButton, PremiumEmptyState, PremiumSkeleton } from "../../../components/layout";
import { Button } from "../../../components/ui";
import {
	useSeerrRequests,
	useApproveSeerrRequest,
	useDeclineSeerrRequest,
	useDeleteSeerrRequest,
} from "../../../hooks/api/useSeerr";
import type { SeerrRequest } from "@arr/shared";
import { RequestCard } from "./request-card";

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
	const [sort, setSort] = useState<RequestSort>("added");
	const [take, setTake] = useState(PAGE_SIZE);
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
	const [confirmingDeclineId, setConfirmingDeclineId] = useState<number | null>(null);
	const [confirmingDeleteId, setConfirmingDeleteId] = useState<number | null>(null);

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

	const requests = data?.results ?? [];

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
				<p className="text-sm text-muted-foreground">
					{totalResults} pending request{totalResults !== 1 ? "s" : ""}
				</p>
				<FilterSelect
					value={sort}
					onChange={(v) => setSort(v as RequestSort)}
					options={SORT_OPTIONS}
					className="min-w-[120px]"
				/>
			</div>
			{requests.map((request, index) => (
				<RequestCard
					key={request.id}
					request={request}
					index={index}
					onClick={() => onSelectRequest?.(request)}
					actions={
						<>
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
			))}

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
		</div>
	);
};
