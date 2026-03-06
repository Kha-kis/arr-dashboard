"use client";

import type { SeerrRequest } from "@arr/shared";
import { AlertCircle, Check, Loader2, Trash2, X } from "lucide-react";
import { useCallback, useMemo, useState } from "react";
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
	const { gradient: themeGradient } = useThemeGradient();
	const [sort, setSort] = useState<RequestSort>("added");
	const [take, setTake] = useState(PAGE_SIZE);
	const [selectedIds, setSelectedIds] = useState<Set<number>>(new Set());
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
							toast.warning(
								`${result.totalSuccess} succeeded, ${result.totalFailed} failed`,
							);
						}
					},
					onError: () => toast.error(`Failed to ${action} requests`),
				},
			);
		},
		[instanceId, selectedIds, bulkMutation],
	);

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
					value={sort}
					onChange={(v) => setSort(v as RequestSort)}
					options={SORT_OPTIONS}
					className="min-w-[120px]"
				/>
			</div>
			{requests.map((request, index) => (
				<div key={request.id} className="flex items-start gap-3">
					<label className="flex items-center pt-4 cursor-pointer shrink-0">
						<input
							type="checkbox"
							checked={selectedIds.has(request.id)}
							onChange={() => toggleSelect(request.id)}
							className="h-4 w-4 rounded border-border/50"
							style={{ accentColor: themeGradient.from }}
						/>
					</label>
					<div className="flex-1 min-w-0">
						<RequestCard
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
					</div>
				</div>
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
							onClick={() => handleBulkAction("decline")}
							className="gap-1.5 border-border/50 bg-card/50"
						>
							<X className="h-3.5 w-3.5" />
							Decline All
						</Button>
						<Button
							variant="secondary"
							size="sm"
							disabled={bulkMutation.isPending}
							onClick={() => handleBulkAction("delete")}
							className="gap-1.5 border-border/50 bg-card/50 text-red-400 hover:text-red-300"
						>
							<Trash2 className="h-3 w-3" />
							Delete All
						</Button>
					</div>
				</div>
			)}
		</div>
	);
};
