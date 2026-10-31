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
import { Alert, AlertDescription, Button } from "../../../components/ui";
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
	const auditQuery = useSeerrAuditLog(instanceId);
	const { data: logs, isLoading } = auditQuery;

	if (isLoading) {
		return (
			<div className="space-y-2 mt-4">
				{Array.from({ length: 5 }, (_, i) => (
					<PremiumSkeleton key={i} className="h-12 w-full rounded-lg" />
				))}
			</div>
		);
	}

	return (
		<>
			{auditQuery.isError || logs === undefined ? (
				<Alert variant="danger">
					<AlertDescription>
						Action history unavailable.
						{logs !== undefined ? " Showing last-known action history." : ""}
						{instanceId ? (
							<Button
								variant="secondary"
								disabled={auditQuery.isFetching}
								onClick={() => void auditQuery.refetch()}
							>
								Retry
							</Button>
						) : null}
					</AlertDescription>
				</Alert>
			) : null}
			{logs === undefined ? null : logs.length === 0 ? (
				auditQuery.isError ? null : (
					<PremiumEmptyState
						icon={History}
						title="No Action History"
						description="Actions like approving, declining, or deleting requests will appear here."
					/>
				)
			) : (
				<PremiumTable>
					<table className="min-w-full text-sm text-muted-foreground">
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
										<StatusBadge
											status={
												log.detail?.outcome === "unknown"
													? "warning"
													: log.success
														? "success"
														: "error"
											}
										>
											{log.detail?.outcome === "unknown"
												? "Unknown"
												: log.success
													? "Success"
													: "Failed"}
										</StatusBadge>
									</td>
								</PremiumTableRow>
							))}
						</tbody>
					</table>
				</PremiumTable>
			)}
		</>
	);
};
