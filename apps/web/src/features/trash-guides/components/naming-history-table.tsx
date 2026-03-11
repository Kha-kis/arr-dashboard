"use client";

import { format } from "date-fns";
import {
	AlertCircle,
	CheckCircle2,
	ChevronLeft,
	ChevronRight,
	Clock,
	History,
	Loader2,
	Undo2,
	XCircle,
} from "lucide-react";
import { useState } from "react";
import { useNamingHistory, useRollbackNaming } from "../../../hooks/api/useNaming";
import { useThemeGradient } from "../../../hooks/useThemeGradient";
import { SEMANTIC_COLORS } from "../../../lib/theme-gradients";

// ============================================================================
// Status Badge
// ============================================================================

const STATUS_CONFIG = {
	PENDING: { label: "Pending", Icon: Clock, color: SEMANTIC_COLORS.warning },
	SUCCESS: { label: "Success", Icon: CheckCircle2, color: SEMANTIC_COLORS.success },
	FAILED: { label: "Failed", Icon: XCircle, color: SEMANTIC_COLORS.error },
	ROLLED_BACK: { label: "Rolled Back", Icon: Undo2, color: SEMANTIC_COLORS.info },
} as const;

function NamingStatusBadge({ status }: { status: keyof typeof STATUS_CONFIG }) {
	const config = STATUS_CONFIG[status];
	if (!config) return <span className="text-xs text-muted-foreground">{status}</span>;

	const { label, Icon, color } = config;
	return (
		<span
			className="inline-flex items-center gap-1.5 rounded-lg px-2.5 py-1 text-xs font-medium"
			style={{
				backgroundColor: color.bg,
				borderColor: color.border,
				color: color.text,
			}}
		>
			<Icon className="h-3.5 w-3.5" />
			{label}
		</span>
	);
}

// ============================================================================
// Main Component
// ============================================================================

interface NamingHistoryTableProps {
	instanceId: string;
}

const PAGE_SIZE = 20;

export function NamingHistoryTable({ instanceId }: NamingHistoryTableProps) {
	const { gradient: themeGradient } = useThemeGradient();
	const [offset, setOffset] = useState(0);
	const [rollbackConfirmId, setRollbackConfirmId] = useState<string | null>(null);

	const { data, isLoading, error } = useNamingHistory(instanceId, { limit: PAGE_SIZE, offset });
	const rollbackMutation = useRollbackNaming();

	const history = data?.data?.history ?? [];
	const pagination = data?.data?.pagination;

	function handlePrevious() {
		setOffset((prev) => Math.max(0, prev - PAGE_SIZE));
		setRollbackConfirmId(null);
	}

	function handleNext() {
		if (pagination?.hasMore) {
			setOffset((prev) => prev + PAGE_SIZE);
			setRollbackConfirmId(null);
		}
	}

	function handleRollback(historyId: string) {
		rollbackMutation.mutate(
			{ historyId, instanceId },
			{
				onSuccess: () => {
					setRollbackConfirmId(null);
				},
			},
		);
	}

	// ── Loading ──────────────────────────────────────────────────────────
	if (isLoading) {
		return (
			<div className="flex items-center justify-center p-12 rounded-2xl border border-border/50 bg-card/30 backdrop-blur-xs">
				<div
					className="h-8 w-8 animate-spin rounded-full border-2 border-t-transparent"
					style={{ borderColor: `${themeGradient.from}40`, borderTopColor: "transparent" }}
				/>
				<span className="ml-4 text-muted-foreground">Loading deployment history...</span>
			</div>
		);
	}

	// ── Error ────────────────────────────────────────────────────────────
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
					<XCircle className="h-5 w-5 shrink-0" style={{ color: SEMANTIC_COLORS.error.from }} />
					<div>
						<p className="font-medium text-foreground">Failed to load deployment history</p>
						<p className="text-sm text-muted-foreground mt-1">{error.message}</p>
					</div>
				</div>
			</div>
		);
	}

	// ── Empty ────────────────────────────────────────────────────────────
	if (history.length === 0) {
		return (
			<div className="rounded-2xl border border-dashed border-border/50 bg-card/20 backdrop-blur-xs p-12 text-center">
				<History className="h-12 w-12 mx-auto mb-4 text-muted-foreground" />
				<p className="text-lg font-medium text-foreground mb-2">No deployment history</p>
				<p className="text-sm text-muted-foreground">Deploy naming presets to see history here</p>
			</div>
		);
	}

	// ── Table ────────────────────────────────────────────────────────────
	return (
		<div className="space-y-4 animate-in fade-in duration-300">
			<div className="rounded-2xl border border-border/50 bg-card/30 backdrop-blur-xs overflow-hidden">
				<table className="w-full">
					<thead>
						<tr className="border-b border-border/50">
							<th className="px-6 py-4 text-left text-xs font-semibold uppercase tracking-wider text-muted-foreground">
								Timestamp
							</th>
							<th className="px-6 py-4 text-left text-xs font-semibold uppercase tracking-wider text-muted-foreground">
								Status
							</th>
							<th className="px-6 py-4 text-left text-xs font-semibold uppercase tracking-wider text-muted-foreground">
								Changes
							</th>
							<th className="px-6 py-4 text-left text-xs font-semibold uppercase tracking-wider text-muted-foreground">
								Error
							</th>
							<th className="px-6 py-4 text-right text-xs font-semibold uppercase tracking-wider text-muted-foreground">
								Actions
							</th>
						</tr>
					</thead>
					<tbody>
						{history.map((entry, index) => (
							<tr
								key={entry.id}
								className="border-b border-border/30 last:border-0 transition-colors hover:bg-card/50 animate-in fade-in"
								style={{
									animationDelay: `${index * 30}ms`,
									animationFillMode: "backwards",
								}}
							>
								{/* Timestamp */}
								<td className="px-6 py-4">
									<div className="flex flex-col">
										<span className="font-medium text-foreground">
											{format(new Date(entry.deployedAt), "MMM d, yyyy")}
										</span>
										<span className="text-xs text-muted-foreground">
											{format(new Date(entry.deployedAt), "h:mm a")}
										</span>
									</div>
								</td>

								{/* Status */}
								<td className="px-6 py-4">
									<NamingStatusBadge status={entry.status} />
								</td>

								{/* Changes */}
								<td className="px-6 py-4">
									<span className="text-sm text-foreground">
										{entry.changedFields} of {entry.totalFields} fields
									</span>
								</td>

								{/* Error */}
								<td className="px-6 py-4">
									{entry.errorMessage ? (
										<span
											className="text-xs max-w-[200px] truncate block"
											style={{ color: SEMANTIC_COLORS.error.text }}
											title={entry.errorMessage}
										>
											{entry.errorMessage}
										</span>
									) : (
										<span className="text-xs text-muted-foreground">—</span>
									)}
								</td>

								{/* Actions */}
								<td className="px-6 py-4 text-right">
									{entry.status === "SUCCESS" && !entry.rolledBack ? (
										rollbackConfirmId === entry.id ? (
											<div className="flex items-center justify-end gap-2">
												{rollbackMutation.isPending ? (
													<span className="flex items-center gap-1.5 text-xs text-muted-foreground">
														<Loader2 className="h-3.5 w-3.5 animate-spin" />
														Rolling back...
													</span>
												) : (
													<>
														<button
															type="button"
															onClick={() => setRollbackConfirmId(null)}
															className="rounded-lg border border-border/50 px-3 py-1.5 text-xs font-medium transition-colors hover:bg-card/80"
														>
															Cancel
														</button>
														<button
															type="button"
															onClick={() => handleRollback(entry.id)}
															className="rounded-lg px-3 py-1.5 text-xs font-medium transition-colors"
															style={{
																backgroundColor: SEMANTIC_COLORS.error.bg,
																borderColor: SEMANTIC_COLORS.error.border,
																color: SEMANTIC_COLORS.error.text,
															}}
														>
															Confirm Rollback
														</button>
													</>
												)}
											</div>
										) : (
											<button
												type="button"
												onClick={() => setRollbackConfirmId(entry.id)}
												className="inline-flex items-center gap-1.5 rounded-lg px-3 py-1.5 text-xs font-medium transition-colors hover:bg-card/80"
												style={{ color: themeGradient.from }}
											>
												<Undo2 className="h-3.5 w-3.5" />
												Rollback
											</button>
										)
									) : entry.rolledBack ? (
										<span className="inline-flex items-center gap-1.5 rounded-lg px-2.5 py-1 text-xs font-medium bg-muted/20 text-muted-foreground">
											Rolled back
										</span>
									) : null}
								</td>
							</tr>
						))}
					</tbody>
				</table>
			</div>

			{/* Rollback error banner */}
			{rollbackMutation.isError && (
				<div
					className="flex items-center gap-2 rounded-lg border px-4 py-3 text-sm"
					style={{
						borderColor: SEMANTIC_COLORS.error.border,
						backgroundColor: SEMANTIC_COLORS.error.bg,
						color: SEMANTIC_COLORS.error.text,
					}}
				>
					<AlertCircle className="h-4 w-4 shrink-0" />
					Rollback failed: {rollbackMutation.error.message}
				</div>
			)}

			{/* Pagination */}
			{pagination && pagination.total > PAGE_SIZE && (
				<div className="flex items-center justify-between">
					<p className="text-sm text-muted-foreground">
						Showing <span className="font-medium text-foreground">{offset + 1}</span> to{" "}
						<span className="font-medium text-foreground">
							{Math.min(offset + history.length, pagination.total)}
						</span>{" "}
						of <span className="font-medium text-foreground">{pagination.total}</span> deployments
					</p>
					<div className="flex items-center gap-2">
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
			)}
		</div>
	);
}
