"use client";

import { useState } from "react";
import {
	useAllDeploymentHistory,
	useTemplateDeploymentHistory,
	useInstanceDeploymentHistory,
	useUndeployDeployment,
	useDeleteDeploymentHistory,
} from "../../../hooks/api/useDeploymentHistory";
import type { DeploymentHistoryEntry } from "../../../lib/api-client/trash-guides";
import { format } from "date-fns";
import { DeploymentHistoryDetailsModal } from "./deployment-history-details-modal";

interface DeploymentHistoryTableProps {
	templateId?: string;
	instanceId?: string;
	limit?: number;
}

export function DeploymentHistoryTable({
	templateId,
	instanceId,
	limit = 20,
}: DeploymentHistoryTableProps) {
	const [offset, setOffset] = useState(0);
	const [selectedHistoryId, setSelectedHistoryId] = useState<string | null>(null);
	const [deleteConfirmId, setDeleteConfirmId] = useState<string | null>(null);
	const [undeployConfirmId, setUndeployConfirmId] = useState<string | null>(null);
	const undeployMutation = useUndeployDeployment();
	const deleteMutation = useDeleteDeploymentHistory();

	// Use appropriate hook based on props
	const { data, isLoading, error } = templateId
		? useTemplateDeploymentHistory(templateId, { limit, offset })
		: instanceId
			? useInstanceDeploymentHistory(instanceId, { limit, offset })
			: useAllDeploymentHistory({ limit, offset });

	if (isLoading) {
		return (
			<div className="flex items-center justify-center p-8">
				<div className="text-sm text-muted-foreground">
					Loading deployment history...
				</div>
			</div>
		);
	}

	if (error) {
		return (
			<div className="rounded-lg border border-destructive bg-destructive/10 p-4">
				<p className="text-sm font-medium text-destructive">
					Failed to load deployment history
				</p>
				<p className="mt-1 text-xs text-destructive/80">{error.message}</p>
			</div>
		);
	}

	if (!data?.data?.history || data.data.history.length === 0) {
		return (
			<div className="rounded-lg border border-dashed p-8 text-center">
				<p className="text-sm text-muted-foreground">
					No deployment history found
				</p>
			</div>
		);
	}

	const { history, pagination } = data.data;

	const handlePrevious = () => {
		setOffset(Math.max(0, offset - limit));
	};

	const handleNext = () => {
		if (pagination.hasMore) {
			setOffset(offset + limit);
		}
	};

	return (
		<div className="space-y-4">
			<div className="rounded-lg border">
				<div className="overflow-x-auto">
					<table className="w-full">
						<thead className="border-b bg-muted/50">
							<tr>
								<th className="px-4 py-3 text-left text-xs font-medium text-muted-foreground">
									Timestamp
								</th>
								{!templateId && !instanceId && (
									<th className="px-4 py-3 text-left text-xs font-medium text-muted-foreground">
										Template
									</th>
								)}
								<th className="px-4 py-3 text-left text-xs font-medium text-muted-foreground">
									{templateId ? "Instance" : instanceId ? "Template" : "Instance"}
								</th>
								<th className="px-4 py-3 text-left text-xs font-medium text-muted-foreground">
									Status
								</th>
								<th className="px-4 py-3 text-left text-xs font-medium text-muted-foreground">
									Duration
								</th>
								<th className="px-4 py-3 text-left text-xs font-medium text-muted-foreground">
									Results
								</th>
								<th className="px-4 py-3 text-left text-xs font-medium text-muted-foreground">
									Actions
								</th>
							</tr>
						</thead>
						<tbody className="divide-y">
							{history.map((entry) => (
								<tr
									key={entry.id}
									className="hover:bg-muted/50 transition-colors"
								>
									<td className="px-4 py-3 text-sm">
										<div className="flex flex-col">
											<span className="font-medium">
												{format(new Date(entry.deployedAt), "MMM d, yyyy")}
											</span>
											<span className="text-xs text-muted-foreground">
												{format(new Date(entry.deployedAt), "h:mm a")}
											</span>
										</div>
									</td>
									{!templateId && !instanceId && (
										<td className="px-4 py-3 text-sm">
											<div className="flex flex-col">
												<span className="font-medium">
													{entry.template?.name || "Unknown"}
												</span>
												<span className="text-xs text-muted-foreground">
													{entry.template?.serviceType}
												</span>
											</div>
										</td>
									)}
									<td className="px-4 py-3 text-sm">
										{templateId || !instanceId ? (
											<div className="flex flex-col">
												<span className="font-medium">
													{entry.instance?.label || "Unknown"}
												</span>
												<span className="text-xs text-muted-foreground">
													{entry.instance?.service}
												</span>
											</div>
										) : (
											<div className="flex flex-col">
												<span className="font-medium">
													{entry.template?.name || "Unknown"}
												</span>
												<span className="text-xs text-muted-foreground">
													{entry.template?.serviceType}
												</span>
											</div>
										)}
									</td>
									<td className="px-4 py-3">
										<StatusBadge status={entry.status} />
									</td>
									<td className="px-4 py-3 text-sm text-muted-foreground">
										{entry.duration ? `${entry.duration}s` : "-"}
									</td>
									<td className="px-4 py-3 text-sm">
										<div className="flex flex-col space-y-1">
											<div className="flex items-center gap-2">
												<span className="text-green-600 dark:text-green-400">
													{entry.appliedCFs} applied
												</span>
											</div>
											{entry.failedCFs > 0 && (
												<div className="flex items-center gap-2">
													<span className="text-red-600 dark:text-red-400">
														{entry.failedCFs} failed
													</span>
												</div>
											)}
										</div>
									</td>
									<td className="px-4 py-3">
										<div className="flex items-center gap-2">
											<button
												onClick={() => setSelectedHistoryId(entry.id)}
												className="text-xs text-primary hover:underline"
											>
												View Details
											</button>
											{!entry.rolledBack && (
												undeployConfirmId === entry.id ? (
													<div className="flex items-center gap-1">
														<button
															className="text-xs text-destructive hover:underline disabled:opacity-50 disabled:cursor-not-allowed"
															onClick={() => {
																undeployMutation.mutate(entry.id, {
																	onSuccess: () => setUndeployConfirmId(null),
																});
															}}
															disabled={undeployMutation.isPending}
														>
															{undeployMutation.isPending ? "Undeploying..." : "Confirm"}
														</button>
														<button
															className="text-xs text-muted-foreground hover:underline"
															onClick={() => setUndeployConfirmId(null)}
															disabled={undeployMutation.isPending}
														>
															Cancel
														</button>
													</div>
												) : (
													<button
														className="text-xs text-orange-600 dark:text-orange-400 hover:underline"
														onClick={() => setUndeployConfirmId(entry.id)}
														title="Remove Custom Formats deployed by this template (shared CFs will be kept)"
													>
														Undeploy
													</button>
												)
											)}
											{entry.rolledBack && (
												<span className="text-xs text-muted-foreground">
													Undeployed
												</span>
											)}
											{deleteConfirmId === entry.id ? (
												<div className="flex items-center gap-1">
													<button
														className="text-xs text-destructive hover:underline disabled:opacity-50 disabled:cursor-not-allowed"
														onClick={() => {
															deleteMutation.mutate(entry.id, {
																onSuccess: () => setDeleteConfirmId(null),
															});
														}}
														disabled={deleteMutation.isPending}
													>
														{deleteMutation.isPending ? "Deleting..." : "Confirm"}
													</button>
													<button
														className="text-xs text-muted-foreground hover:underline"
														onClick={() => setDeleteConfirmId(null)}
														disabled={deleteMutation.isPending}
													>
														Cancel
													</button>
												</div>
											) : (
												<button
													className="text-xs text-muted-foreground hover:text-destructive hover:underline"
													onClick={() => setDeleteConfirmId(entry.id)}
												>
													Delete
												</button>
											)}
										</div>
									</td>
								</tr>
							))}
						</tbody>
					</table>
				</div>
			</div>

			{/* Pagination Controls */}
			<div className="flex items-center justify-between">
				<p className="text-sm text-muted-foreground">
					Showing {offset + 1} to {offset + history.length} of{" "}
					{pagination.total} deployments
				</p>
				<div className="flex gap-2">
					<button
						onClick={handlePrevious}
						disabled={offset === 0}
						className="px-3 py-1 text-sm rounded border hover:bg-muted disabled:opacity-50 disabled:cursor-not-allowed"
					>
						Previous
					</button>
					<button
						onClick={handleNext}
						disabled={!pagination.hasMore}
						className="px-3 py-1 text-sm rounded border hover:bg-muted disabled:opacity-50 disabled:cursor-not-allowed"
					>
						Next
					</button>
				</div>
			</div>

			{/* Details Modal */}
			{selectedHistoryId && (
				<DeploymentHistoryDetailsModal
					historyId={selectedHistoryId}
					onClose={() => setSelectedHistoryId(null)}
					onUndeploy={(historyId) => {
						undeployMutation.mutate(historyId, {
							onSuccess: () => {
								setSelectedHistoryId(null);
							},
						});
					}}
				/>
			)}
		</div>
	);
}

function StatusBadge({ status }: { status: string }) {
	const statusConfig: Record<
		string,
		{ label: string; className: string }
	> = {
		SUCCESS: {
			label: "Success",
			className: "bg-green-100 text-green-800 dark:bg-green-900/30 dark:text-green-400",
		},
		PARTIAL_SUCCESS: {
			label: "Partial",
			className: "bg-yellow-100 text-yellow-800 dark:bg-yellow-900/30 dark:text-yellow-400",
		},
		FAILED: {
			label: "Failed",
			className: "bg-red-100 text-red-800 dark:bg-red-900/30 dark:text-red-400",
		},
		IN_PROGRESS: {
			label: "In Progress",
			className: "bg-blue-100 text-blue-800 dark:bg-blue-900/30 dark:text-blue-400",
		},
	};

	const config = statusConfig[status] || {
		label: status,
		className: "bg-gray-100 text-gray-800 dark:bg-gray-900/30 dark:text-gray-400",
	};

	return (
		<span
			className={`inline-flex items-center rounded-full px-2.5 py-0.5 text-xs font-medium ${config.className}`}
		>
			{config.label}
		</span>
	);
}
