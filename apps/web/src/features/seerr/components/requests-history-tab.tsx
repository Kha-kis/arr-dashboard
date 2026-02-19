"use client";

import { useState, useMemo } from "react";
import { AlertCircle, ClipboardList, Trash2 } from "lucide-react";
import { toast } from "sonner";
import { SEERR_REQUEST_STATUS } from "@arr/shared";
import { FilterSelect, PremiumEmptyState, PremiumSkeleton } from "../../../components/layout";
import { Button } from "../../../components/ui";
import {
	useSeerrRequests,
	useDeleteSeerrRequest,
	useRetrySeerrRequest,
	useSeerrUsers,
} from "../../../hooks/api/useSeerr";
import { RequestCard } from "./request-card";

type RequestFilter =
	| "all"
	| "approved"
	| "available"
	| "pending"
	| "processing"
	| "unavailable"
	| "failed";
type TypeFilter = "all" | "movie" | "tv";

const STATUS_OPTIONS: { value: RequestFilter; label: string }[] = [
	{ value: "all", label: "All Statuses" },
	{ value: "pending", label: "Pending" },
	{ value: "approved", label: "Approved" },
	{ value: "available", label: "Available" },
	{ value: "processing", label: "Processing" },
	{ value: "failed", label: "Failed" },
];

const TYPE_OPTIONS: { value: TypeFilter; label: string }[] = [
	{ value: "all", label: "All Types" },
	{ value: "movie", label: "Movies" },
	{ value: "tv", label: "TV Shows" },
];

interface RequestsHistoryTabProps {
	instanceId: string;
}

export const RequestsHistoryTab = ({ instanceId }: RequestsHistoryTabProps) => {
	const [statusFilter, setStatusFilter] = useState<RequestFilter>("all");
	const [typeFilter, setTypeFilter] = useState<TypeFilter>("all");
	const [userFilter, setUserFilter] = useState<string>("all");

	const requestedBy = userFilter !== "all" ? Number(userFilter) : undefined;
	const { data, isLoading, isError } = useSeerrRequests({
		instanceId,
		filter: statusFilter,
		take: 50,
		requestedBy,
	});
	const { data: usersData } = useSeerrUsers({ instanceId, take: 50, sort: "displayname" });
	const deleteMutation = useDeleteSeerrRequest();
	const retryMutation = useRetrySeerrRequest();
	const [confirmingDeleteId, setConfirmingDeleteId] = useState<number | null>(null);

	const userOptions = useMemo(() => {
		const base: { value: string; label: string }[] = [{ value: "all", label: "All Users" }];
		if (!usersData?.results) return base;
		for (const user of usersData.results) {
			base.push({
				value: String(user.id),
				label: user.displayName || user.email || `User #${user.id}`,
			});
		}
		return base;
	}, [usersData]);

	// Client-side type filter (Overseerr API doesn't support type filtering)
	const allRequests = data?.results ?? [];
	const requests =
		typeFilter === "all" ? allRequests : allRequests.filter((r) => r.type === typeFilter);

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

	return (
		<div className="space-y-4">
			<div className="flex flex-wrap items-center justify-between gap-3">
				<p className="text-sm text-muted-foreground">
					{requests.length === allRequests.length
						? `${data?.pageInfo.results ?? 0} total requests`
						: `${requests.length} of ${data?.pageInfo.results ?? 0} requests`}
				</p>
				<div className="flex flex-wrap items-center gap-2">
					<FilterSelect
						value={typeFilter}
						onChange={(v) => setTypeFilter(v as TypeFilter)}
						options={TYPE_OPTIONS}
						className="min-w-[120px]"
					/>
					<FilterSelect
						value={statusFilter}
						onChange={(v) => setStatusFilter(v as RequestFilter)}
						options={STATUS_OPTIONS}
						className="min-w-[140px]"
					/>
					<FilterSelect
						value={userFilter}
						onChange={setUserFilter}
						options={userOptions}
						className="min-w-[140px]"
					/>
				</div>
			</div>

			{requests.length === 0 ? (
				<PremiumEmptyState
					icon={ClipboardList}
					title="No Requests Found"
					description="No requests match the current filters."
				/>
			) : (
				<div className="space-y-3">
					{requests.map((request, index) => (
						<RequestCard
							key={request.id}
							request={request}
							index={index}
							actions={
								<>
									{request.status === SEERR_REQUEST_STATUS.FAILED && (
										<Button
											variant="secondary"
											size="sm"
											disabled={retryMutation.isPending}
											onClick={() =>
												retryMutation.mutate(
													{ instanceId, requestId: request.id },
													{
														onSuccess: () => toast.success("Request retried"),
														onError: () => toast.error("Failed to retry request"),
													},
												)
											}
											className="gap-1.5 border-border/50 bg-card/50 text-xs"
										>
											Retry
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
											className="gap-1.5 border-border/50 bg-card/50 text-xs"
										>
											<Trash2 className="h-3 w-3" />
										</Button>
									)}
								</>
							}
						/>
					))}
				</div>
			)}
		</div>
	);
};
