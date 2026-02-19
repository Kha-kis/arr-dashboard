"use client";

import { Check, X } from "lucide-react";
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
	const { data, isLoading } = useSeerrRequests({ instanceId, filter: "pending", take: 50 });
	const approveMutation = useApproveSeerrRequest();
	const declineMutation = useDeclineSeerrRequest();

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
								onClick={() => approveMutation.mutate({ instanceId, requestId: request.id })}
							>
								Approve
							</GradientButton>
							<Button
								variant="secondary"
								size="sm"
								disabled={declineMutation.isPending}
								onClick={() => declineMutation.mutate({ instanceId, requestId: request.id })}
								className="gap-1.5 border-border/50 bg-card/50"
							>
								<X className="h-3.5 w-3.5" />
								Decline
							</Button>
						</>
					}
				/>
			))}
		</div>
	);
};
