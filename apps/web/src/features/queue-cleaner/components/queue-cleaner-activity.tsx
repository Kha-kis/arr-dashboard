"use client";

import {
	Activity,
	AlertTriangle,
	ChevronDown,
	ChevronRight,
	Clock,
	Eye,
	SkipForward,
	Trash2,
} from "lucide-react";
import { useState } from "react";
import {
	FilterSelect,
	PremiumEmptyState,
	PremiumSection,
	ServiceBadge,
	StatusBadge,
} from "../../../components/layout";
import { getLinuxInstanceName, getLinuxIsoName, useIncognitoMode } from "../../../lib/incognito";
import { getServiceGradient, SEMANTIC_COLORS } from "../../../lib/theme-gradients";
import { useQueueCleanerLogs } from "../hooks/useQueueCleanerLogs";
import type { CleanerResultItem, QueueCleanerLog } from "../lib/queue-cleaner-types";

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
						onToggle={() => setExpandedLogId(expandedLogId === logEntry.id ? null : logEntry.id)}
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
	const [incognitoMode] = useIncognitoMode();
	const serviceGradient = getServiceGradient(log.service);
	const hasDetails =
		(log.cleanedItems && log.cleanedItems.length > 0) ||
		(log.skippedItems && log.skippedItems.length > 0) ||
		(log.warnedItems && log.warnedItems.length > 0);

	const statusType =
		{
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
			className="group relative rounded-xl overflow-hidden transition-all duration-200 hover:-translate-y-[1px] hover:shadow-lg hover:shadow-black/10 animate-in fade-in slide-in-from-bottom-1 duration-300"
			style={{
				border: `1px solid ${serviceGradient.from}10`,
				animationDelay: `${animationDelay}ms`,
				animationFillMode: "backwards",
			}}
		>
			{/* Background gradient */}
			<div
				className="absolute inset-0 pointer-events-none"
				style={{
					background: `linear-gradient(135deg, ${serviceGradient.from}05, transparent 60%)`,
				}}
			/>

			{/* Hover glow */}
			<div
				className="absolute inset-0 pointer-events-none opacity-0 group-hover:opacity-100 transition-opacity duration-200"
				style={{
					background: `radial-gradient(ellipse at top left, ${serviceGradient.from}08, transparent 50%)`,
				}}
			/>

			{/* Service accent bar */}
			<div
				className="absolute left-0 top-0 bottom-0 w-[3px]"
				style={{
					background: `linear-gradient(180deg, ${serviceGradient.from}, ${serviceGradient.to}70)`,
				}}
			/>

			{/* Main row */}
			<button
				type="button"
				className="relative w-full py-3.5 pl-5 pr-4 text-left flex items-center gap-3"
				onClick={hasDetails ? onToggle : undefined}
			>
				{/* Expand chevron */}
				<div className="flex-shrink-0 w-4">
					{hasDetails &&
						(isExpanded ? (
							<ChevronDown className="h-4 w-4 text-muted-foreground/40" />
						) : (
							<ChevronRight className="h-4 w-4 text-muted-foreground/40" />
						))}
				</div>

				{/* Instance info */}
				<div className="flex-1 min-w-0">
					<div className="flex items-center gap-2 mb-0.5">
						<span
							className="inline-flex items-center gap-1 rounded-md px-1.5 py-0.5 text-[10px] font-semibold uppercase tracking-wider shrink-0"
							style={{
								backgroundColor: `${serviceGradient.from}12`,
								color: serviceGradient.from,
							}}
						>
							<Trash2 className="h-2.5 w-2.5" />
							Clean
						</span>
						<span className="text-[14px] font-semibold text-foreground truncate leading-snug">
							{incognitoMode ? getLinuxInstanceName(log.instanceName) : log.instanceName}
						</span>
						<ServiceBadge service={log.service} />
						{log.isDryRun && (
							<span className="inline-flex items-center gap-1 rounded-md bg-amber-500/10 px-1.5 py-0.5 text-[10px] font-semibold text-amber-400 border border-amber-500/15">
								<Eye className="h-2.5 w-2.5" />
								DRY
							</span>
						)}
						{log.hasDataError && (
							<span
								className="inline-flex items-center rounded-md bg-amber-500/10 px-1.5 py-0.5 text-[10px] font-semibold text-amber-400"
								title="Some item details may be incomplete due to data corruption"
							>
								<AlertTriangle className="h-2.5 w-2.5" />
							</span>
						)}
					</div>
					<p className="text-[11px] text-muted-foreground/40 truncate">
						{log.message || "No details"}
					</p>
				</div>

				{/* Stats */}
				<div className="flex items-center gap-4 flex-shrink-0">
					<span className="inline-flex items-center gap-1 text-[11px] text-muted-foreground/50">
						<Trash2 className="h-3 w-3" style={{ color: SEMANTIC_COLORS.error.text }} />
						{log.itemsCleaned}
					</span>
					{(log.itemsWarned ?? 0) > 0 && (
						<span className="inline-flex items-center gap-1 text-[11px] text-muted-foreground/50">
							<AlertTriangle
								className="h-3 w-3"
								style={{ color: SEMANTIC_COLORS.warning.text }}
							/>
							{log.itemsWarned}
						</span>
					)}
					<span className="inline-flex items-center gap-1 text-[11px] text-muted-foreground/50">
						<SkipForward className="h-3 w-3" />
						{log.itemsSkipped}
					</span>
					<span className="text-[11px] text-muted-foreground/40 flex items-center gap-1 min-w-[60px]">
						<Clock className="h-3 w-3" />
						{durationStr}
					</span>
					<StatusBadge status={statusType}>{log.status}</StatusBadge>
				</div>
			</button>

			{/* Expanded details */}
			{isExpanded && hasDetails && (
				<div className="relative px-5 pb-4 pt-0 border-t border-border/20">
					<div className="pt-3 space-y-3">
						{/* Timestamp */}
						<p className="text-xs text-muted-foreground/40">
							Started: {startedAt.toLocaleString()}
						</p>

						{/* Cleaned items */}
						{log.cleanedItems && log.cleanedItems.length > 0 && (
							<div>
								<h5 className="flex items-center gap-1.5 text-xs font-medium mb-2">
									<Trash2
										className="h-3 w-3"
										style={{ color: SEMANTIC_COLORS.error.text }}
									/>
									Removed ({log.cleanedItems.length})
								</h5>
								<div className="space-y-1">
									{log.cleanedItems.map((item: CleanerResultItem) => (
										<div
											key={item.id}
											className="flex items-center justify-between rounded-lg px-3 py-2"
											style={{
												backgroundColor: SEMANTIC_COLORS.error.bg,
												border: `1px solid ${SEMANTIC_COLORS.error.border}`,
											}}
										>
											<span className="text-xs text-foreground truncate flex-1">
												{incognitoMode ? getLinuxIsoName(item.title) : item.title}
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
									<AlertTriangle
										className="h-3 w-3"
										style={{ color: SEMANTIC_COLORS.warning.text }}
									/>
									Warned ({log.warnedItems.length})
								</h5>
								<div className="space-y-1">
									{log.warnedItems.map((item: CleanerResultItem) => (
										<div
											key={item.id}
											className="flex items-center justify-between rounded-lg px-3 py-2"
											style={{
												backgroundColor: SEMANTIC_COLORS.warning.bg,
												border: `1px solid ${SEMANTIC_COLORS.warning.border}`,
											}}
										>
											<span className="text-xs text-foreground truncate flex-1">
												{incognitoMode ? getLinuxIsoName(item.title) : item.title}
											</span>
											<div className="flex items-center gap-2 ml-2 shrink-0">
												{item.strikeCount !== undefined &&
													item.maxStrikes !== undefined && (
														<span className="inline-flex items-center rounded-md bg-amber-500/20 px-1.5 py-0.5 text-[9px] font-medium text-amber-400">
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
									<SkipForward
										className="h-3 w-3"
										style={{ color: SEMANTIC_COLORS.warning.text }}
									/>
									Skipped ({log.skippedItems.length})
								</h5>
								<div className="space-y-1 max-h-40 overflow-y-auto">
									{log.skippedItems.slice(0, 10).map((item: CleanerResultItem) => (
										<div
											key={item.id}
											className="flex items-center justify-between rounded-lg px-3 py-2"
											style={{
												backgroundColor: `${serviceGradient.from}06`,
												border: `1px solid ${serviceGradient.from}10`,
											}}
										>
											<span className="text-xs text-foreground truncate flex-1">
												{incognitoMode ? getLinuxIsoName(item.title) : item.title}
											</span>
											<span className="text-[10px] text-muted-foreground ml-2 shrink-0">
												{item.reason}
											</span>
										</div>
									))}
									{log.skippedItems.length > 10 && (
										<p className="text-[10px] text-muted-foreground/40 text-center py-1">
											...and {log.skippedItems.length - 10} more
										</p>
									)}
								</div>
							</div>
						)}
					</div>
				</div>
			)}
		</div>
	);
};
