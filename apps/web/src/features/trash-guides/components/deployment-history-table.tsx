"use client";

import { format } from "date-fns";
import { lazy, Suspense, useState } from "react";
import {
	useDeleteDeploymentHistory,
	useDeploymentHistory,
	useUndeployDeployment,
} from "../../../hooks/api/useDeploymentHistory";

// Lazy-loaded modal — only fetched when the user opens it
const DeploymentHistoryDetailsModal = lazy(() =>
	import("./deployment-history-details-modal").then((m) => ({
		default: m.DeploymentHistoryDetailsModal,
	})),
);

import {
	AlertTriangle,
	CheckCircle2,
	ChevronLeft,
	ChevronRight,
	Clock,
	Eye,
	History,
	Loader2,
	type LucideIcon,
	Trash2,
	Undo2,
	XCircle,
} from "lucide-react";
import {
	PremiumEmptyState,
	PremiumTable,
	PremiumTableHeader,
	PremiumTableRow,
	StatusBadge,
} from "../../../components/layout";
import { useThemeGradient } from "../../../hooks/useThemeGradient";
import { SEMANTIC_COLORS } from "../../../lib/theme-gradients";

interface DeploymentHistoryTableProps {
	templateId?: string;
	instanceId?: string;
	limit?: number;
}

/**
 * Deployment status → shared StatusBadge mapping
 */
const DEPLOYMENT_STATUS_CONFIG: Record<
	string,
	{
		label: string;
		icon: LucideIcon;
		variant: "success" | "warning" | "error" | "info";
	}
> = {
	SUCCESS: { label: "Success", icon: CheckCircle2, variant: "success" },
	PARTIAL_SUCCESS: { label: "Partial", icon: AlertTriangle, variant: "warning" },
	FAILED: { label: "Failed", icon: XCircle, variant: "error" },
	IN_PROGRESS: { label: "In Progress", icon: Clock, variant: "info" },
};

const DeploymentStatusBadge = ({ status }: { status: string }) => {
	const config = DEPLOYMENT_STATUS_CONFIG[status];
	if (!config) {
		return (
			<StatusBadge status="default" icon={Clock}>
				{status}
			</StatusBadge>
		);
	}
	return (
		<StatusBadge status={config.variant} icon={config.icon}>
			{config.label}
		</StatusBadge>
	);
};

/**
 * Premium Deployment History Table
 *
 * Features:
 * - Glassmorphic table design
 * - Theme-aware styling
 * - Animated interactions
 * - Premium pagination
 */
export function DeploymentHistoryTable({
	templateId,
	instanceId,
	limit = 20,
}: DeploymentHistoryTableProps) {
	const { gradient: themeGradient } = useThemeGradient();

	const [offset, setOffset] = useState(0);
	const [selectedHistoryId, setSelectedHistoryId] = useState<string | null>(null);
	const [deleteConfirmId, setDeleteConfirmId] = useState<string | null>(null);
	const [undeployConfirmId, setUndeployConfirmId] = useState<string | null>(null);
	const undeployMutation = useUndeployDeployment();
	const deleteMutation = useDeleteDeploymentHistory();

	const { data, isLoading, error } = useDeploymentHistory(templateId, instanceId, {
		limit,
		offset,
	});

	// Loading State
	if (isLoading) {
		return (
			<div className="flex items-center justify-center p-12 rounded-2xl border border-border/30 bg-muted/10">
				<div
					className="h-8 w-8 animate-spin rounded-full border-2 border-t-transparent"
					style={{ borderColor: `${themeGradient.from}40`, borderTopColor: "transparent" }}
				/>
				<span className="ml-4 text-muted-foreground">Loading deployment history...</span>
			</div>
		);
	}

	// Error State
	if (error) {
		return (
			<div
				className="rounded-2xl border p-6 backdrop-blur-xs"
				style={{
					backgroundColor: SEMANTIC_COLORS.error.bg,
					borderColor: SEMANTIC_COLORS.error.border,
				}}
			>
				<div className="flex items-center gap-3">
					<XCircle className="h-5 w-5" style={{ color: SEMANTIC_COLORS.error.from }} />
					<div>
						<p className="font-medium text-foreground">Failed to load deployment history</p>
						<p className="text-sm text-muted-foreground mt-1">{error.message}</p>
					</div>
				</div>
			</div>
		);
	}

	// Empty State
	if (!data?.data?.history || data.data.history.length === 0) {
		return (
			<PremiumEmptyState
				icon={History}
				title="No deployment history"
				description="Deployments will appear here once you deploy templates to instances"
			/>
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
		<div className="space-y-4 animate-in fade-in duration-300">
			{/* Table Container */}
			<PremiumTable>
				<table className="w-full">
					<PremiumTableHeader>
						<tr>
							<th className="px-6 py-4 text-left text-xs font-semibold uppercase tracking-wider text-muted-foreground">
								Timestamp
							</th>
							{!templateId && !instanceId && (
								<th className="px-6 py-4 text-left text-xs font-semibold uppercase tracking-wider text-muted-foreground">
									Template
								</th>
							)}
							<th className="px-6 py-4 text-left text-xs font-semibold uppercase tracking-wider text-muted-foreground">
								{templateId ? "Instance" : instanceId ? "Template" : "Instance"}
							</th>
							<th className="px-6 py-4 text-left text-xs font-semibold uppercase tracking-wider text-muted-foreground">
								Status
							</th>
							<th className="px-6 py-4 text-left text-xs font-semibold uppercase tracking-wider text-muted-foreground">
								Duration
							</th>
							<th className="px-6 py-4 text-left text-xs font-semibold uppercase tracking-wider text-muted-foreground">
								Results
							</th>
							<th className="px-6 py-4 text-left text-xs font-semibold uppercase tracking-wider text-muted-foreground">
								Actions
							</th>
						</tr>
					</PremiumTableHeader>
					<tbody>
						{history.map((entry, index) => (
							<PremiumTableRow
								key={entry.id}
								className="animate-in fade-in"
								style={{
									animationDelay: `${index * 30}ms`,
									animationFillMode: "backwards",
								}}
							>
								<td className="px-6 py-4 text-sm">
									<div className="flex flex-col">
										<span className="font-medium text-foreground">
											{format(new Date(entry.deployedAt), "MMM d, yyyy")}
										</span>
										<span className="text-xs text-muted-foreground">
											{format(new Date(entry.deployedAt), "h:mm a")}
										</span>
									</div>
								</td>
								{!templateId && !instanceId && (
									<td className="px-6 py-4 text-sm">
										<div className="flex flex-col">
											<span className="font-medium text-foreground">
												{entry.template?.name || "Unknown"}
											</span>
											<span className="text-xs text-muted-foreground">
												{entry.template?.serviceType}
											</span>
										</div>
									</td>
								)}
								<td className="px-6 py-4 text-sm">
									{templateId || !instanceId ? (
										<div className="flex flex-col">
											<span className="font-medium text-foreground">
												{entry.instance?.label || "Unknown"}
											</span>
											<span className="text-xs text-muted-foreground">
												{entry.instance?.service}
											</span>
										</div>
									) : (
										<div className="flex flex-col">
											<span className="font-medium text-foreground">
												{entry.template?.name || "Unknown"}
											</span>
											<span className="text-xs text-muted-foreground">
												{entry.template?.serviceType}
											</span>
										</div>
									)}
								</td>
								<td className="px-6 py-4">
									<DeploymentStatusBadge status={entry.status} />
								</td>
								<td className="px-6 py-4 text-sm text-muted-foreground">
									{entry.duration ? `${entry.duration}s` : "-"}
								</td>
								<td className="px-6 py-4 text-sm">
									<div className="flex items-center gap-3">
										<span
											className="flex items-center gap-1"
											style={{ color: SEMANTIC_COLORS.success.from }}
										>
											<CheckCircle2 className="h-3.5 w-3.5" />
											{entry.appliedCFs}
										</span>
										{entry.failedCFs > 0 && (
											<span
												className="flex items-center gap-1"
												style={{ color: SEMANTIC_COLORS.error.from }}
											>
												<XCircle className="h-3.5 w-3.5" />
												{entry.failedCFs}
											</span>
										)}
									</div>
								</td>
								<td className="px-6 py-4">
									<div className="flex items-center gap-2">
										{/* View Details Button */}
										<button
											type="button"
											onClick={() => setSelectedHistoryId(entry.id)}
											className="inline-flex items-center gap-1.5 rounded-lg px-3 py-1.5 text-xs font-medium transition-colors hover:bg-card/80"
											style={{ color: themeGradient.from }}
										>
											<Eye className="h-3.5 w-3.5" />
											Details
										</button>

										{/* Undeploy Button */}
										{!entry.rolledBack &&
											(undeployConfirmId === entry.id ? (
												<div className="flex items-center gap-1">
													<button
														type="button"
														onClick={() => {
															undeployMutation.mutate(entry.id, {
																onSuccess: () => setUndeployConfirmId(null),
															});
														}}
														disabled={undeployMutation.isPending}
														className="rounded-lg px-2.5 py-1.5 text-xs font-medium transition-colors"
														style={{
															backgroundColor: SEMANTIC_COLORS.error.bg,
															border: `1px solid ${SEMANTIC_COLORS.error.border}`,
															color: SEMANTIC_COLORS.error.text,
														}}
													>
														{undeployMutation.isPending ? (
															<Loader2 className="h-3.5 w-3.5 animate-spin" />
														) : (
															"Confirm"
														)}
													</button>
													<button
														type="button"
														onClick={() => setUndeployConfirmId(null)}
														disabled={undeployMutation.isPending}
														className="rounded-lg px-2.5 py-1.5 text-xs font-medium text-muted-foreground hover:text-foreground transition-colors"
													>
														Cancel
													</button>
												</div>
											) : (
												<button
													type="button"
													onClick={() => setUndeployConfirmId(entry.id)}
													className="inline-flex items-center gap-1.5 rounded-lg px-3 py-1.5 text-xs font-medium transition-colors hover:bg-card/80"
													style={{ color: SEMANTIC_COLORS.warning.from }}
													title="Remove Custom Formats deployed by this template"
												>
													<Undo2 className="h-3.5 w-3.5" />
													Undeploy
												</button>
											))}

										{/* Undeployed Badge */}
										{entry.rolledBack && (
											<span className="inline-flex items-center gap-1.5 rounded-lg px-2.5 py-1 text-xs font-medium bg-muted/20 text-muted-foreground">
												Undeployed
											</span>
										)}

										{/* Delete Button */}
										{deleteConfirmId === entry.id ? (
											<div className="flex items-center gap-1">
												<button
													type="button"
													onClick={() => {
														deleteMutation.mutate(entry.id, {
															onSuccess: () => setDeleteConfirmId(null),
														});
													}}
													disabled={deleteMutation.isPending}
													className="rounded-lg px-2.5 py-1.5 text-xs font-medium transition-colors"
													style={{
														backgroundColor: SEMANTIC_COLORS.error.bg,
														border: `1px solid ${SEMANTIC_COLORS.error.border}`,
														color: SEMANTIC_COLORS.error.text,
													}}
												>
													{deleteMutation.isPending ? (
														<Loader2 className="h-3.5 w-3.5 animate-spin" />
													) : (
														"Confirm"
													)}
												</button>
												<button
													type="button"
													onClick={() => setDeleteConfirmId(null)}
													disabled={deleteMutation.isPending}
													className="rounded-lg px-2.5 py-1.5 text-xs font-medium text-muted-foreground hover:text-foreground transition-colors"
												>
													Cancel
												</button>
											</div>
										) : (
											<button
												type="button"
												onClick={() => setDeleteConfirmId(entry.id)}
												className="rounded-lg p-1.5 text-muted-foreground hover:text-foreground transition-colors hover:bg-card/80"
											>
												<Trash2 className="h-3.5 w-3.5" />
											</button>
										)}
									</div>
								</td>
							</PremiumTableRow>
						))}
					</tbody>
				</table>
			</PremiumTable>
			{/* Pagination */}
			<div className="flex items-center justify-between">
				<p className="text-sm text-muted-foreground">
					Showing <span className="font-medium text-foreground">{offset + 1}</span> to{" "}
					<span className="font-medium text-foreground">{offset + history.length}</span> of{" "}
					<span className="font-medium text-foreground">{pagination.total}</span> deployments
				</p>
				<div className="flex gap-2">
					<button
						type="button"
						onClick={handlePrevious}
						disabled={offset === 0}
						className="inline-flex items-center gap-1.5 rounded-xl px-4 py-2 text-sm font-medium transition-all duration-200 disabled:opacity-50 disabled:cursor-not-allowed border border-border/50 bg-card/30 hover:bg-card/50"
					>
						<ChevronLeft className="h-4 w-4" />
						Previous
					</button>
					<button
						type="button"
						onClick={handleNext}
						disabled={!pagination.hasMore}
						className="inline-flex items-center gap-1.5 rounded-xl px-4 py-2 text-sm font-medium transition-all duration-200 disabled:opacity-50 disabled:cursor-not-allowed border border-border/50 bg-card/30 hover:bg-card/50"
					>
						Next
						<ChevronRight className="h-4 w-4" />
					</button>
				</div>
			</div>
			{/* Details Modal (lazy-loaded) */}
			{selectedHistoryId && (
				<Suspense>
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
				</Suspense>
			)}
		</div>
	);
}
