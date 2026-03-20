"use client";

import {
	Activity,
	AlertCircle,
	ArrowUpCircle,
	CheckCircle2,
	ChevronDown,
	ChevronUp,
	Clock,
	Download,
	HardDrive,
	ListChecks,
	Loader2,
	type LucideIcon,
	Search,
} from "lucide-react";
import { useEffect, useState } from "react";
import {
	FilterSelect,
	PremiumEmptyState,
	PremiumSection,
	PremiumSkeleton,
	ServiceBadge,
	StatusBadge,
} from "../../../components/layout";
import { Pagination } from "../../../components/ui";
import { getLinuxIndexer, getLinuxInstanceName, getLinuxIsoName, useIncognitoMode } from "../../../lib/incognito";
import { getServiceGradient, SEMANTIC_COLORS } from "../../../lib/theme-gradients";
import { useHuntingLogs } from "../hooks/useHuntingLogs";
import type { HuntLog } from "../lib/hunting-types";

/**
 * Premium Hunting Activity
 *
 * Activity log with:
 * - Glassmorphic filter controls
 * - Expandable activity entries
 * - Service-aware styling
 * - Theme-aware status badges
 */
export const HuntingActivity = () => {
	const [incognitoMode] = useIncognitoMode();
	const [typeFilter, setTypeFilter] = useState<string>("all");
	const [statusFilter, setStatusFilter] = useState<string>("all");
	const [page, setPage] = useState(1);
	const [pageSize, setPageSize] = useState(20);
	const [hasRunningHunts, setHasRunningHunts] = useState(false);

	const {
		logs,
		totalCount,
		isLoading,
		error,
		hasRunningHunts: logsHaveRunning,
	} = useHuntingLogs({
		type: typeFilter === "all" ? undefined : typeFilter,
		status: statusFilter === "all" ? undefined : statusFilter,
		page,
		pageSize,
		hasRunningHunts,
	});

	// Update running state for fast polling
	useEffect(() => {
		if (logsHaveRunning !== hasRunningHunts) {
			setHasRunningHunts(logsHaveRunning);
		}
	}, [logsHaveRunning, hasRunningHunts]);

	// Loading state
	if (isLoading) {
		return (
			<PremiumSection
				title="Hunt Activity Log"
				description="Recent hunting activity across all instances"
				icon={Activity}
			>
				<div className="space-y-4">
					{Array.from({ length: 5 }).map((_, i) => (
						<PremiumSkeleton
							key={i}
							variant="card"
							className="h-20"
							style={{ animationDelay: `${i * 50}ms` } as React.CSSProperties}
						/>
					))}
				</div>
			</PremiumSection>
		);
	}

	// Error state
	if (error) {
		return (
			<PremiumEmptyState
				icon={AlertCircle}
				title="Failed to load activity"
				description="Could not fetch hunting activity logs. Please try again."
			/>
		);
	}

	// Filter options
	const typeOptions = [
		{ value: "all", label: "All Types" },
		{ value: "missing", label: "Missing Content" },
		{ value: "upgrade", label: "Quality Upgrades" },
	];

	const statusOptions = [
		{ value: "all", label: "All Status" },
		{ value: "running", label: "Running" },
		{ value: "completed", label: "Completed" },
		{ value: "partial", label: "Partial" },
		{ value: "skipped", label: "Skipped" },
		{ value: "error", label: "Error" },
	];

	return (
		<PremiumSection
			title="Hunt Activity Log"
			description="Recent hunting activity across all instances"
			icon={Activity}
		>
			{/* Filters */}
			<div className="rounded-xl border border-border/30 bg-muted/10 p-4 mb-6">
				<div className="flex flex-wrap gap-4">
					<FilterSelect
						label="Type"
						value={typeFilter}
						onChange={(value) => {
							setTypeFilter(value);
							setPage(1);
						}}
						options={typeOptions}
					/>
					<FilterSelect
						label="Status"
						value={statusFilter}
						onChange={(value) => {
							setStatusFilter(value);
							setPage(1);
						}}
						options={statusOptions}
					/>
				</div>
			</div>

			{/* Activity List */}
			{logs.length === 0 ? (
				<PremiumEmptyState
					icon={Activity}
					title="No activity yet"
					description="Hunt activity will appear here once hunting is configured and running."
				/>
			) : (
				<>
					<div className="space-y-3">
						{logs.map((log, index) => (
							<ActivityLogEntry key={log.id} log={log} animationDelay={index * 30} />
						))}
					</div>

					{/* Pagination */}
					{totalCount > pageSize && (
						<div className="mt-6">
							<Pagination
								currentPage={page}
								totalItems={totalCount}
								pageSize={pageSize}
								onPageChange={setPage}
								onPageSizeChange={setPageSize}
							/>
						</div>
					)}
				</>
			)}
		</PremiumSection>
	);
};

/* =============================================================================
   ACTIVITY LOG ENTRY
   Expandable activity entry with premium styling
   ============================================================================= */

interface ActivityLogEntryProps {
	log: HuntLog;
	animationDelay?: number;
}

const ActivityLogEntry = ({ log, animationDelay = 0 }: ActivityLogEntryProps) => {
	const [incognitoMode] = useIncognitoMode();
	const [expanded, setExpanded] = useState(false);

	const Icon = log.huntType === "missing" ? Search : ArrowUpCircle;
	const isRunning = log.status === "running";

	// Status configuration
	type BadgeStatus = "success" | "warning" | "error" | "info" | "default";
	const statusConfig: Record<string, { status: BadgeStatus; icon: LucideIcon }> = {
		running: { status: "info", icon: Loader2 },
		completed: { status: "success", icon: CheckCircle2 },
		partial: { status: "warning", icon: AlertCircle },
		skipped: { status: "default", icon: Clock },
		error: { status: "error", icon: AlertCircle },
	};

	const statusInfo = statusConfig[log.status] ?? statusConfig.error!;
	const StatusIcon = statusInfo.icon;

	// Get service gradient for accent bar
	const serviceGradient = getServiceGradient(log.service);

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

			{/* Header */}
			<button
				type="button"
				onClick={() => setExpanded(!expanded)}
				className="relative w-full py-3.5 pl-5 pr-4 flex items-center justify-between transition-colors"
			>
				<div className="flex items-center gap-3 min-w-0">
					{/* Hunt type pill */}
					<span
						className="inline-flex items-center gap-1 rounded-md px-1.5 py-0.5 text-[10px] font-semibold uppercase tracking-wider shrink-0"
						style={{
							backgroundColor: `${serviceGradient.from}12`,
							color: serviceGradient.from,
						}}
					>
						<Icon className="h-2.5 w-2.5" />
						{log.huntType === "missing" ? "Missing" : "Upgrade"}
					</span>

					{/* Info */}
					<div className="text-left min-w-0">
						<div className="flex items-center gap-2 flex-wrap">
							<span className="font-semibold text-[14px] text-foreground leading-snug">
								{incognitoMode ? getLinuxInstanceName(log.instanceName) : log.instanceName}
							</span>
							<ServiceBadge service={log.service} />
							<StatusBadge status={statusInfo.status} icon={StatusIcon}>
								{isRunning ? "In Progress" : log.status}
							</StatusBadge>
						</div>
					</div>
				</div>

				{/* Right side stats */}
				<div className="flex items-center gap-4 text-sm text-muted-foreground shrink-0">
					<div className="flex items-center gap-3">
						{isRunning ? (
							<div className="flex items-center gap-1">
								<Loader2
									className="h-3 w-3 animate-spin"
									style={{ color: serviceGradient.from }}
								/>
								<span>Searching...</span>
							</div>
						) : (
							<>
								<span className="inline-flex items-center gap-1 text-[11px] text-muted-foreground/50">
									<ListChecks className="h-3 w-3 shrink-0" />
									{log.itemsSearched} searched
								</span>
								<span
									className={`inline-flex items-center gap-1 text-[11px] ${log.itemsGrabbed > 0 ? "" : "text-muted-foreground/50"}`}
									style={
										log.itemsGrabbed > 0
											? { color: SEMANTIC_COLORS.success.text }
											: undefined
									}
								>
									<Download className="h-3 w-3 shrink-0" />
									{log.itemsGrabbed} grabbed
								</span>
							</>
						)}
					</div>
					<span className="text-[11px] text-muted-foreground/40">
						{isRunning ? (
							<span style={{ color: serviceGradient.from }}>
								Started {formatTime(log.startedAt)}
							</span>
						) : (
							formatTime(log.startedAt)
						)}
					</span>
					{/* Expand indicator */}
					{expanded ? (
						<ChevronUp className="h-4 w-4 text-muted-foreground/40" />
					) : (
						<ChevronDown className="h-4 w-4 text-muted-foreground/40" />
					)}
				</div>
			</button>

			{/* Expanded Details */}
			{expanded && (
				<div className="relative px-5 py-4 border-t border-border/20 text-sm space-y-4">
					{/* Message */}
					{log.message && (
						<p className="text-[11.5px] text-muted-foreground/50">{log.message}</p>
					)}

					{/* Metadata */}
					<div className="flex flex-wrap gap-4 text-xs text-muted-foreground/40">
						{log.durationMs && (
							<span className="flex items-center gap-1">
								<Clock className="h-3 w-3" />
								Duration: {(log.durationMs / 1000).toFixed(1)}s
							</span>
						)}
						<span>Started: {new Date(log.startedAt).toLocaleString()}</span>
						{log.completedAt && (
							<span>Completed: {new Date(log.completedAt).toLocaleString()}</span>
						)}
					</div>

					{/* Grabbed Items */}
					{log.grabbedItems && log.grabbedItems.length > 0 && (
						<div>
							<h4
								className="text-xs font-semibold mb-2 flex items-center gap-1"
								style={{ color: SEMANTIC_COLORS.success.text }}
							>
								<Download className="h-3.5 w-3.5" />
								Grabbed Releases:
							</h4>
							<div className="space-y-1.5">
								{log.grabbedItems.slice(0, 10).map((item, i) => (
									<div
										key={i}
										className="flex items-center gap-2 text-xs rounded-lg px-3 py-2"
										style={{
											backgroundColor: SEMANTIC_COLORS.success.bg,
											border: `1px solid ${SEMANTIC_COLORS.success.border}`,
										}}
									>
										<span className="font-medium text-foreground flex-1">{incognitoMode ? getLinuxIsoName(item.title) : item.title}</span>
										{item.quality && (
											<StatusBadge status="success">{item.quality}</StatusBadge>
										)}
										{item.indexer && (
											<span className="text-muted-foreground">{incognitoMode ? getLinuxIndexer(item.indexer) : item.indexer}</span>
										)}
										{item.size && (
											<span className="text-muted-foreground flex items-center gap-1">
												<HardDrive className="h-3 w-3" />
												{formatSize(item.size)}
											</span>
										)}
									</div>
								))}
								{log.grabbedItems.length > 10 && (
									<div className="text-xs text-muted-foreground/40 pl-3">
										+{log.grabbedItems.length - 10} more grabbed
									</div>
								)}
							</div>
						</div>
					)}

					{/* Searched Items */}
					{log.searchedItems && log.searchedItems.length > 0 && (
						<div>
							<h4 className="text-xs font-semibold text-muted-foreground/50 mb-2">
								Searched Items:
							</h4>
							<div className="flex flex-wrap gap-1.5">
								{log.searchedItems.slice(0, 10).map((item, i) => (
									<span
										key={i}
										className="text-xs px-2 py-1 rounded-md text-muted-foreground/50"
										style={{
											backgroundColor: `${serviceGradient.from}08`,
											border: `1px solid ${serviceGradient.from}10`,
										}}
									>
										{item}
									</span>
								))}
								{log.searchedItems.length > 10 && (
									<span
										className="text-xs px-2 py-1 rounded-md text-muted-foreground/40"
										style={{
											backgroundColor: `${serviceGradient.from}08`,
											border: `1px solid ${serviceGradient.from}10`,
										}}
									>
										+{log.searchedItems.length - 10} more
									</span>
								)}
							</div>
						</div>
					)}
				</div>
			)}
		</div>
	);
};

/* =============================================================================
   UTILITY FUNCTIONS
   ============================================================================= */

/**
 * Format a date string to local time
 */
function formatTime(dateString: string): string {
	const date = new Date(dateString);
	return date.toLocaleTimeString(undefined, { hour: "2-digit", minute: "2-digit" });
}

/**
 * Format bytes to human-readable size
 */
function formatSize(bytes: number): string {
	if (bytes === 0) return "0 B";
	const k = 1024;
	const sizes = ["B", "KB", "MB", "GB", "TB"];
	const i = Math.floor(Math.log(bytes) / Math.log(k));
	return `${parseFloat((bytes / k ** i).toFixed(1))} ${sizes[i]}`;
}
