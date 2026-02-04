"use client";

import { useState } from "react";
import {
	Activity,
	ChevronDown,
	ChevronRight,
	Clock,
	Trash2,
	SkipForward,
	Eye,
	AlertTriangle,
} from "lucide-react";
import {
	PremiumSection,
	PremiumEmptyState,
	ServiceBadge,
	StatusBadge,
	FilterSelect,
	GlassmorphicCard,
} from "../../../components/layout";
import { getServiceGradient, SEMANTIC_COLORS } from "../../../lib/theme-gradients";
import { useQueueCleanerLogs } from "../hooks/useQueueCleanerLogs";
import type { QueueCleanerLog, CleanerResultItem } from "../lib/queue-cleaner-types";

export const QueueCleanerActivity = () => {
	const [statusFilter, setStatusFilter] = useState("all");
	const [page, setPage] = useState(1);
	const [expandedLogId, setExpandedLogId] = useState<string | null>(null);

	const { logs, totalCount, isLoading } = useQueueCleanerLogs({
		status: statusFilter !== "all" ? statusFilter : undefined,
		page,
		pageSize: 20,
		hasRunningCleans: true,
	});

	const totalPages = Math.ceil(totalCount / 20);

	return (
		<PremiumSection
			title="Activity Log"
			description="Recent queue cleaner runs and their results"
			icon={Activity}
			animationDelay={0}
		>
			{/* Filters */}
			<div className="flex flex-wrap gap-3 mb-4">
				<FilterSelect
					label="Status"
					value={statusFilter}
					onChange={(val) => {
						setStatusFilter(val);
						setPage(1);
					}}
					options={[
						{ value: "all", label: "All Statuses" },
						{ value: "completed", label: "Completed" },
						{ value: "partial", label: "Partial" },
						{ value: "skipped", label: "Skipped" },
						{ value: "error", label: "Error" },
						{ value: "running", label: "Running" },
					]}
				/>
			</div>

			{/* Log entries */}
			{logs.length === 0 && !isLoading && (
				<PremiumEmptyState
					icon={Activity}
					title="No activity yet"
					description="Queue cleaner activity will appear here once runs begin."
				/>
			)}

			<div className="space-y-2">
				{logs.map((logEntry, index) => (
					<LogEntryRow
						key={logEntry.id}
						log={logEntry}
						isExpanded={expandedLogId === logEntry.id}
						onToggle={() =>
							setExpandedLogId(
								expandedLogId === logEntry.id ? null : logEntry.id,
							)
						}
						animationDelay={index * 30}
					/>
				))}
			</div>

			{/* Pagination */}
			{totalPages > 1 && (
				<div className="flex items-center justify-center gap-2 mt-4">
					<button
						type="button"
						className="px-3 py-1.5 text-xs rounded-lg border border-border/50 bg-card/50 text-muted-foreground hover:bg-card/80 disabled:opacity-50"
						onClick={() => setPage((p) => Math.max(1, p - 1))}
						disabled={page <= 1}
					>
						Previous
					</button>
					<span className="text-xs text-muted-foreground">
						Page {page} of {totalPages}
					</span>
					<button
						type="button"
						className="px-3 py-1.5 text-xs rounded-lg border border-border/50 bg-card/50 text-muted-foreground hover:bg-card/80 disabled:opacity-50"
						onClick={() => setPage((p) => Math.min(totalPages, p + 1))}
						disabled={page >= totalPages}
					>
						Next
					</button>
				</div>
			)}
		</PremiumSection>
	);
};

interface LogEntryRowProps {
	log: QueueCleanerLog;
	isExpanded: boolean;
	onToggle: () => void;
	animationDelay: number;
}

const LogEntryRow = ({ log, isExpanded, onToggle, animationDelay }: LogEntryRowProps) => {
	const serviceGradient = getServiceGradient(log.service);
	const hasDetails =
		(log.cleanedItems && log.cleanedItems.length > 0) ||
		(log.skippedItems && log.skippedItems.length > 0) ||
		(log.warnedItems && log.warnedItems.length > 0);

	const statusType = {
		running: "warning" as const,
		completed: "success" as const,
		partial: "warning" as const,
		skipped: "info" as const,
		error: "error" as const,
	}[log.status] ?? ("info" as const);

	const startedAt = new Date(log.startedAt);
	const durationStr = log.durationMs ? `${(log.durationMs / 1000).toFixed(1)}s` : "-";

	return (
		<div
			className="animate-in fade-in slide-in-from-bottom-1 duration-200"
			style={{ animationDelay: `${animationDelay}ms`, animationFillMode: "backwards" }}
		>
			<GlassmorphicCard>
				{/* Accent line */}
				<div
					className="absolute top-0 left-0 w-0.5 h-full rounded-l-xl"
					style={{ backgroundColor: serviceGradient.from }}
				/>

				{/* Main row */}
				<button
					type="button"
					className="w-full p-4 text-left flex items-center gap-3"
					onClick={hasDetails ? onToggle : undefined}
				>
					{/* Expand chevron */}
					<div className="flex-shrink-0 w-4">
						{hasDetails && (
							isExpanded ? (
								<ChevronDown className="h-4 w-4 text-muted-foreground" />
							) : (
								<ChevronRight className="h-4 w-4 text-muted-foreground" />
							)
						)}
					</div>

					{/* Instance info */}
					<div className="flex-1 min-w-0">
						<div className="flex items-center gap-2 mb-0.5">
							<span className="text-sm font-medium text-foreground truncate">
								{log.instanceName}
							</span>
							<ServiceBadge service={log.service} />
							{log.isDryRun && (
								<span className="inline-flex items-center gap-1 rounded-full bg-amber-500/10 px-1.5 py-0.5 text-[9px] font-medium text-amber-400">
									<Eye className="h-2.5 w-2.5" />
									DRY
								</span>
							)}
						</div>
						<p className="text-xs text-muted-foreground truncate">
							{log.message || "No details"}
						</p>
					</div>

					{/* Stats */}
					<div className="flex items-center gap-4 flex-shrink-0">
						<div className="text-center">
							<div className="flex items-center gap-1 text-xs">
								<Trash2 className="h-3 w-3" style={{ color: SEMANTIC_COLORS.error.text }} />
								<span className="font-medium">{log.itemsCleaned}</span>
							</div>
						</div>
						{(log.itemsWarned ?? 0) > 0 && (
							<div className="text-center">
								<div className="flex items-center gap-1 text-xs">
									<AlertTriangle className="h-3 w-3" style={{ color: SEMANTIC_COLORS.warning.text }} />
									<span className="font-medium">{log.itemsWarned}</span>
								</div>
							</div>
						)}
						<div className="text-center">
							<div className="flex items-center gap-1 text-xs">
								<SkipForward className="h-3 w-3" style={{ color: SEMANTIC_COLORS.warning.text }} />
								<span className="font-medium">{log.itemsSkipped}</span>
							</div>
						</div>
						<div className="text-xs text-muted-foreground flex items-center gap-1 min-w-[60px]">
							<Clock className="h-3 w-3" />
							{durationStr}
						</div>
						<StatusBadge status={statusType}>
							{log.status}
						</StatusBadge>
						{/* Data quality warning - shown when JSON parsing failed */}
						{log.hasDataError && (
							<span
								className="inline-flex items-center rounded-full bg-amber-500/10 px-1.5 py-0.5 text-[9px] font-medium text-amber-400"
								title="Some item details may be incomplete due to data corruption"
							>
								<AlertTriangle className="h-2.5 w-2.5" />
							</span>
						)}
					</div>
				</button>

				{/* Expanded details */}
				{isExpanded && hasDetails && (
					<div className="px-4 pb-4 pt-0 border-t border-border/30">
						<div className="pt-3 space-y-3">
							{/* Timestamp */}
							<p className="text-xs text-muted-foreground">
								Started: {startedAt.toLocaleString()}
							</p>

							{/* Cleaned items */}
							{log.cleanedItems && log.cleanedItems.length > 0 && (
								<div>
									<h5 className="flex items-center gap-1.5 text-xs font-medium mb-2">
										<Trash2 className="h-3 w-3" style={{ color: SEMANTIC_COLORS.error.text }} />
										Removed ({log.cleanedItems.length})
									</h5>
									<div className="space-y-1">
										{log.cleanedItems.map((item: CleanerResultItem) => (
											<div
												key={item.id}
												className="flex items-center justify-between rounded bg-card/50 px-2.5 py-1.5"
											>
												<span className="text-xs text-foreground truncate flex-1">
													{item.title}
												</span>
												<span className="text-[10px] text-muted-foreground ml-2 shrink-0">
													{item.reason}
												</span>
											</div>
										))}
									</div>
								</div>
							)}

							{/* Warned items (strike system) */}
							{log.warnedItems && log.warnedItems.length > 0 && (
								<div>
									<h5 className="flex items-center gap-1.5 text-xs font-medium mb-2">
										<AlertTriangle className="h-3 w-3" style={{ color: SEMANTIC_COLORS.warning.text }} />
										Warned ({log.warnedItems.length})
									</h5>
									<div className="space-y-1">
										{log.warnedItems.map((item: CleanerResultItem) => (
											<div
												key={item.id}
												className="flex items-center justify-between rounded px-2.5 py-1.5"
												style={{ backgroundColor: SEMANTIC_COLORS.warning.bg }}
											>
												<span className="text-xs text-foreground truncate flex-1">
													{item.title}
												</span>
												<div className="flex items-center gap-2 ml-2 shrink-0">
													{item.strikeCount !== undefined && item.maxStrikes !== undefined && (
														<span className="inline-flex items-center rounded-full bg-amber-500/20 px-1.5 py-0.5 text-[9px] font-medium text-amber-400">
															Strike {item.strikeCount}/{item.maxStrikes}
														</span>
													)}
													<span className="text-[10px] text-muted-foreground">
														{item.reason}
													</span>
												</div>
											</div>
										))}
									</div>
								</div>
							)}

							{/* Skipped items */}
							{log.skippedItems && log.skippedItems.length > 0 && (
								<div>
									<h5 className="flex items-center gap-1.5 text-xs font-medium mb-2">
										<SkipForward className="h-3 w-3" style={{ color: SEMANTIC_COLORS.warning.text }} />
										Skipped ({log.skippedItems.length})
									</h5>
									<div className="space-y-1 max-h-40 overflow-y-auto">
										{log.skippedItems.slice(0, 10).map((item: CleanerResultItem) => (
											<div
												key={item.id}
												className="flex items-center justify-between rounded bg-card/50 px-2.5 py-1.5"
											>
												<span className="text-xs text-foreground truncate flex-1">
													{item.title}
												</span>
												<span className="text-[10px] text-muted-foreground ml-2 shrink-0">
													{item.reason}
												</span>
											</div>
										))}
										{log.skippedItems.length > 10 && (
											<p className="text-[10px] text-muted-foreground text-center py-1">
												...and {log.skippedItems.length - 10} more
											</p>
										)}
									</div>
								</div>
							)}
						</div>
					</div>
				)}
			</GlassmorphicCard>
		</div>
	);
};
