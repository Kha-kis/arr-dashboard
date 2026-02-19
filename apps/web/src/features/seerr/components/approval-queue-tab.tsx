"use client";

import { useState } from "react";
import { AlertCircle, Check, X } from "lucide-react";
import { toast } from "sonner";
import { GradientButton, PremiumEmptyState, PremiumSkeleton } from "../../../components/layout";
import { Button } from "../../../components/ui";
import {
	useSeerrRequests,
	useApproveSeerrRequest,
	useDeclineSeerrRequest,
} from "../../../hooks/api/useSeerr";
import { RequestCard } from "./request-card";

interface ApprovalQueueTabProps {
	instanceId: string;
}

export const ApprovalQueueTab = ({ instanceId }: ApprovalQueueTabProps) => {
	const { data, isLoading, isError } = useSeerrRequests({
		instanceId,
		filter: "pending",
		take: 50,
	});
	const approveMutation = useApproveSeerrRequest();
	const declineMutation = useDeclineSeerrRequest();
	const [confirmingDeclineId, setConfirmingDeclineId] = useState<number | null>(null);

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
			{requests.map((request, index) => (
				<RequestCard
					key={request.id}
					request={request}
					index={index}
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
						</>
					}
				/>
			))}
		</div>
	);
};
