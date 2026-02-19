"use client";

import { useState } from "react";
import { ClipboardList, Trash2 } from "lucide-react";
import { FilterSelect, PremiumEmptyState, PremiumSkeleton } from "../../../components/layout";
import { Button } from "../../../components/ui";
import { useSeerrRequests, useDeleteSeerrRequest, useRetrySeerrRequest } from "../../../hooks/api/useSeerr";
import { RequestCard } from "./request-card";

type RequestFilter = "all" | "approved" | "available" | "pending" | "processing" | "unavailable" | "failed";

const FILTER_OPTIONS: { value: RequestFilter; label: string }[] = [
	{ value: "all", label: "All Requests" },
	{ value: "pending", label: "Pending" },
	{ value: "approved", label: "Approved" },
	{ value: "available", label: "Available" },
	{ value: "processing", label: "Processing" },
	{ value: "failed", label: "Failed" },
];

interface RequestsHistoryTabProps {
	instanceId: string;
}

export const RequestsHistoryTab = ({ instanceId }: RequestsHistoryTabProps) => {
	const [filter, setFilter] = useState<RequestFilter>("all");
	const { data, isLoading } = useSeerrRequests({ instanceId, filter, take: 50 });
	const deleteMutation = useDeleteSeerrRequest();
	const retryMutation = useRetrySeerrRequest();

	if (isLoading) {
		return (
			<div className="space-y-3">
				{Array.from({ length: 3 }).map((_, i) => (
					<PremiumSkeleton key={i} className="h-24 w-full rounded-xl" />
				))}
			</div>
		);
	}

	const requests = data?.results ?? [];

	return (
		<div className="space-y-4">
			<div className="flex items-center justify-between">
				<p className="text-sm text-muted-foreground">
					{data?.pageInfo.results ?? 0} total requests
				</p>
				<FilterSelect
					value={filter}
					onChange={(v) => setFilter(v as RequestFilter)}
					options={FILTER_OPTIONS}
					className="min-w-[140px]"
				/>
			</div>

			{requests.length === 0 ? (
				<PremiumEmptyState
					icon={ClipboardList}
					title="No Requests Found"
					description={`No ${filter === "all" ? "" : filter + " "}requests to display.`}
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
									{request.status === 3 && (
										<Button
											variant="secondary"
											size="sm"
											disabled={retryMutation.isPending}
											onClick={() => retryMutation.mutate({ instanceId, requestId: request.id })}
											className="gap-1.5 border-border/50 bg-card/50 text-xs"
										>
											Retry
										</Button>
									)}
									<Button
										variant="secondary"
										size="sm"
										disabled={deleteMutation.isPending}
										onClick={() => deleteMutation.mutate({ instanceId, requestId: request.id })}
										className="gap-1.5 border-border/50 bg-card/50 text-xs"
									>
										<Trash2 className="h-3 w-3" />
									</Button>
								</>
							}
						/>
					))}
				</div>
			)}
		</div>
	);
};
