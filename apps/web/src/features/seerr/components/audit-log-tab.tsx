"use client";

import { Clock, History } from "lucide-react";
import {
	PremiumEmptyState,
	PremiumSkeleton,
	PremiumTable,
	PremiumTableHeader,
	PremiumTableRow,
	StatusBadge,
} from "../../../components/layout";
import { useSeerrAuditLog } from "../../../hooks/api/useSeerr";
import { formatRelativeTime } from "../lib/seerr-utils";

interface AuditLogTabProps {
	instanceId: string;
}

const ACTION_LABELS: Record<string, string> = {
	approve_request: "Approve Request",
	decline_request: "Decline Request",
	delete_request: "Delete Request",
	retry_request: "Retry Request",
	update_issue_status: "Update Issue Status",
	add_issue_comment: "Add Issue Comment",
};

export const AuditLogTab = ({ instanceId }: AuditLogTabProps) => {
	const { data: logs, isLoading } = useSeerrAuditLog(instanceId);

	if (isLoading) {
		return (
			<div className="space-y-2 mt-4">
				{Array.from({ length: 5 }, (_, i) => (
					<PremiumSkeleton key={i} className="h-12 w-full rounded-lg" />
				))}
			</div>
		);
	}

	if (!logs || logs.length === 0) {
		return (
			<PremiumEmptyState
				icon={History}
				title="No Action History"
				description="Actions like approving, declining, or deleting requests will appear here."
			/>
		);
	}

	return (
		<PremiumTable>
			<PremiumTableHeader>
				<tr>
					<th className="px-4 py-3 text-left text-xs font-medium uppercase tracking-wider text-muted-foreground">
						Time
					</th>
					<th className="px-4 py-3 text-left text-xs font-medium uppercase tracking-wider text-muted-foreground">
						Action
					</th>
					<th className="px-4 py-3 text-left text-xs font-medium uppercase tracking-wider text-muted-foreground">
						Target
					</th>
					<th className="px-4 py-3 text-left text-xs font-medium uppercase tracking-wider text-muted-foreground">
						Status
					</th>
				</tr>
			</PremiumTableHeader>
			<tbody>
				{logs.map((log) => (
					<PremiumTableRow key={log.id}>
						<td className="px-4 py-3 text-sm text-muted-foreground">
							<div className="flex items-center gap-1.5">
								<Clock className="h-3.5 w-3.5 shrink-0 opacity-50" />
								{formatRelativeTime(log.createdAt)}
							</div>
						</td>
						<td className="px-4 py-3 text-sm font-medium">
							{ACTION_LABELS[log.action] ?? log.action}
						</td>
						<td className="px-4 py-3 text-sm text-muted-foreground">
							<span className="capitalize">{log.targetType}</span>
							<span className="mx-1 text-border/80">#</span>
							<span className="font-mono text-xs">{log.targetId}</span>
						</td>
						<td className="px-4 py-3">
							<StatusBadge status={log.success ? "success" : "error"}>
								{log.success ? "Success" : "Failed"}
							</StatusBadge>
						</td>
					</PremiumTableRow>
				))}
			</tbody>
		</PremiumTable>
	);
};
