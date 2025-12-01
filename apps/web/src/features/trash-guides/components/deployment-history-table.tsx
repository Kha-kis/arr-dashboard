"use client";

import { useState } from "react";
import {
	useDeploymentHistory,
	useUndeployDeployment,
	useDeleteDeploymentHistory,
} from "../../../hooks/api/useDeploymentHistory";
import type { DeploymentHistoryEntry } from "../../../lib/api-client/trash-guides";
import { format } from "date-fns";
import { DeploymentHistoryDetailsModal } from "./deployment-history-details-modal";
import { Button, Badge } from "../../../components/ui";
import { Eye, Undo2, Trash2, ChevronLeft, ChevronRight } from "lucide-react";

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

	// Use unified hook that handles all cases unconditionally
	const { data, isLoading, error } = useDeploymentHistory(templateId, instanceId, { limit, offset });

	if (isLoading) {
		return (
			<div className="flex items-center justify-center p-8 rounded-xl border border-white/10 bg-white/5">
				<div className="h-6 w-6 animate-spin rounded-full border-2 border-primary border-t-transparent" />
				<span className="ml-3 text-sm text-white/60">
					Loading deployment history...
				</span>
			</div>
		);
	}

	if (error) {
		return (
			<div className="rounded-xl border border-red-500/30 bg-red-500/10 p-6">
				<p className="text-sm font-medium text-red-400">
					Failed to load deployment history
				</p>
				<p className="mt-1 text-xs text-red-400/70">{error.message}</p>
			</div>
		);
	}

	if (!data?.data?.history || data.data.history.length === 0) {
		return (
			<div className="rounded-xl border border-dashed border-white/20 bg-white/5 p-8 text-center">
				<p className="text-sm text-white/60">
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
			<div className="overflow-hidden rounded-xl border border-white/10 bg-white/5">
				<div className="overflow-x-auto">
					<table className="w-full">
						<thead className="border-b border-white/10 bg-white/5">
							<tr>
								<th className="px-6 py-3 text-left text-xs font-medium uppercase tracking-wider text-white/60">
									Timestamp
								</th>
								{!templateId && !instanceId && (
									<th className="px-6 py-3 text-left text-xs font-medium uppercase tracking-wider text-white/60">
										Template
									</th>
								)}
								<th className="px-6 py-3 text-left text-xs font-medium uppercase tracking-wider text-white/60">
									{templateId ? "Instance" : instanceId ? "Template" : "Instance"}
								</th>
								<th className="px-6 py-3 text-left text-xs font-medium uppercase tracking-wider text-white/60">
									Status
								</th>
								<th className="px-6 py-3 text-left text-xs font-medium uppercase tracking-wider text-white/60">
									Duration
								</th>
								<th className="px-6 py-3 text-left text-xs font-medium uppercase tracking-wider text-white/60">
									Results
								</th>
								<th className="px-6 py-3 text-left text-xs font-medium uppercase tracking-wider text-white/60">
									Actions
								</th>
							</tr>
						</thead>
						<tbody className="divide-y divide-white/10">
							{history.map((entry) => (
								<tr
									key={entry.id}
									className="transition hover:bg-white/5"
								>
									<td className="px-6 py-4 text-sm">
										<div className="flex flex-col">
											<span className="font-medium text-white">
												{format(new Date(entry.deployedAt), "MMM d, yyyy")}
											</span>
											<span className="text-xs text-white/60">
												{format(new Date(entry.deployedAt), "h:mm a")}
											</span>
										</div>
									</td>
									{!templateId && !instanceId && (
										<td className="px-6 py-4 text-sm">
											<div className="flex flex-col">
												<span className="font-medium text-white">
													{entry.template?.name || "Unknown"}
												</span>
												<span className="text-xs text-white/60">
													{entry.template?.serviceType}
												</span>
											</div>
										</td>
									)}
									<td className="px-6 py-4 text-sm">
										{templateId || !instanceId ? (
											<div className="flex flex-col">
												<span className="font-medium text-white">
													{entry.instance?.label || "Unknown"}
												</span>
												<span className="text-xs text-white/60">
													{entry.instance?.service}
												</span>
											</div>
										) : (
											<div className="flex flex-col">
												<span className="font-medium text-white">
													{entry.template?.name || "Unknown"}
												</span>
												<span className="text-xs text-white/60">
													{entry.template?.serviceType}
												</span>
											</div>
										)}
									</td>
									<td className="px-6 py-4">
										<StatusBadge status={entry.status} />
									</td>
									<td className="px-6 py-4 text-sm text-white/60">
										{entry.duration ? `${entry.duration}s` : "-"}
									</td>
									<td className="px-6 py-4 text-sm">
										<div className="flex items-center gap-3 text-xs">
											<span className="text-green-400">✓ {entry.appliedCFs}</span>
											{entry.failedCFs > 0 && (
												<span className="text-red-400">✗ {entry.failedCFs}</span>
											)}
										</div>
									</td>
									<td className="px-6 py-4">
										<div className="flex items-center gap-2">
											<Button
												variant="ghost"
												size="sm"
												onClick={() => setSelectedHistoryId(entry.id)}
												className="gap-1.5"
											>
												<Eye className="h-3.5 w-3.5" />
												Details
											</Button>
											{!entry.rolledBack && (
												undeployConfirmId === entry.id ? (
													<div className="flex items-center gap-1">
														<Button
															variant="danger"
															size="sm"
															onClick={() => {
																undeployMutation.mutate(entry.id, {
																	onSuccess: () => setUndeployConfirmId(null),
																});
															}}
															disabled={undeployMutation.isPending}
														>
															{undeployMutation.isPending ? "Undeploying..." : "Confirm"}
														</Button>
														<Button
															variant="ghost"
															size="sm"
															onClick={() => setUndeployConfirmId(null)}
															disabled={undeployMutation.isPending}
														>
															Cancel
														</Button>
													</div>
												) : (
													<Button
														variant="secondary"
														size="sm"
														onClick={() => setUndeployConfirmId(entry.id)}
														title="Remove Custom Formats deployed by this template (shared CFs will be kept)"
														className="gap-1.5 text-orange-400 hover:text-orange-300"
													>
														<Undo2 className="h-3.5 w-3.5" />
														Undeploy
													</Button>
												)
											)}
											{entry.rolledBack && (
												<Badge variant="default" size="sm">
													Undeployed
												</Badge>
											)}
											{deleteConfirmId === entry.id ? (
												<div className="flex items-center gap-1">
													<Button
														variant="danger"
														size="sm"
														onClick={() => {
															deleteMutation.mutate(entry.id, {
																onSuccess: () => setDeleteConfirmId(null),
															});
														}}
														disabled={deleteMutation.isPending}
													>
														{deleteMutation.isPending ? "Deleting..." : "Confirm"}
													</Button>
													<Button
														variant="ghost"
														size="sm"
														onClick={() => setDeleteConfirmId(null)}
														disabled={deleteMutation.isPending}
													>
														Cancel
													</Button>
												</div>
											) : (
												<Button
													variant="ghost"
													size="sm"
													onClick={() => setDeleteConfirmId(entry.id)}
													className="gap-1.5 text-white/60 hover:text-red-400"
												>
													<Trash2 className="h-3.5 w-3.5" />
												</Button>
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
				<p className="text-sm text-white/70">
					Showing <span className="font-medium text-white">{offset + 1}</span> to{" "}
					<span className="font-medium text-white">{offset + history.length}</span> of{" "}
					<span className="font-medium text-white">{pagination.total}</span> deployments
				</p>
				<div className="flex gap-2">
					<Button
						variant="secondary"
						size="sm"
						onClick={handlePrevious}
						disabled={offset === 0}
						className="gap-1.5"
					>
						<ChevronLeft className="h-4 w-4" />
						Previous
					</Button>
					<Button
						variant="secondary"
						size="sm"
						onClick={handleNext}
						disabled={!pagination.hasMore}
						className="gap-1.5"
					>
						Next
						<ChevronRight className="h-4 w-4" />
					</Button>
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
		{ label: string; variant: "success" | "warning" | "danger" | "info" | "default" }
	> = {
		SUCCESS: {
			label: "Success",
			variant: "success",
		},
		PARTIAL_SUCCESS: {
			label: "Partial",
			variant: "warning",
		},
		FAILED: {
			label: "Failed",
			variant: "danger",
		},
		IN_PROGRESS: {
			label: "In Progress",
			variant: "info",
		},
	};

	const config = statusConfig[status] || {
		label: status,
		variant: "default" as const,
	};

	return (
		<Badge variant={config.variant} size="sm">
			{config.label}
		</Badge>
	);
}
