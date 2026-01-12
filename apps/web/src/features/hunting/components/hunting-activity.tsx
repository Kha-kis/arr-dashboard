"use client";

import { useState, useEffect } from "react";
import {
	Activity,
	Search,
	ArrowUpCircle,
	CheckCircle2,
	AlertCircle,
	Clock,
	ListChecks,
	Loader2,
	Download,
	HardDrive,
	ChevronDown,
	ChevronUp,
	type LucideIcon,
} from "lucide-react";
import { Pagination } from "../../../components/ui";
import {
	PremiumSection,
	PremiumEmptyState,
	GlassmorphicCard,
	FilterSelect,
	ServiceBadge,
	StatusBadge,
	PremiumSkeleton,
} from "../../../components/layout";
import { getServiceGradient, SEMANTIC_COLORS } from "../../../lib/theme-gradients";
import { useThemeGradient } from "../../../hooks/useThemeGradient";
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
	const { gradient: themeGradient } = useThemeGradient();

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
			<GlassmorphicCard padding="md" className="mb-6">
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
			</GlassmorphicCard>

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
							<ActivityLogEntry
								key={log.id}
								log={log}
								animationDelay={index * 30}
							/>
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
	const { gradient: themeGradient } = useThemeGradient();
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

	// Get service gradient
	const serviceGradient = getServiceGradient(log.service);

	return (
		<div
			className="group rounded-xl border border-border/50 bg-card/30 backdrop-blur-sm overflow-hidden
				animate-in fade-in slide-in-from-bottom-2 duration-300 hover:border-border/80 transition-colors"
			style={{
				animationDelay: `${animationDelay}ms`,
				animationFillMode: "backwards",
			}}
		>
			{/* Header */}
			<button
				type="button"
				onClick={() => setExpanded(!expanded)}
				className="w-full px-4 py-4 flex items-center justify-between hover:bg-muted/20 transition-colors"
			>
				<div className="flex items-center gap-4">
					{/* Icon with gradient */}
					<div
						className="flex h-10 w-10 items-center justify-center rounded-xl shrink-0"
						style={{
							background: `linear-gradient(135deg, ${themeGradient.from}20, ${themeGradient.to}20)`,
							border: `1px solid ${themeGradient.from}30`,
						}}
					>
						<Icon className="h-5 w-5" style={{ color: themeGradient.from }} />
					</div>

					{/* Info */}
					<div className="text-left">
						<div className="flex items-center gap-2 flex-wrap">
							<span className="font-semibold text-foreground">{log.instanceName}</span>
							<ServiceBadge service={log.service} />
							<StatusBadge status={statusInfo.status} icon={StatusIcon}>
								{isRunning ? "In Progress" : log.status}
							</StatusBadge>
						</div>
						<div className="text-xs text-muted-foreground mt-0.5">
							{log.huntType === "missing" ? "Missing content search" : "Quality upgrade search"}
						</div>
					</div>
				</div>

				{/* Right side stats */}
				<div className="flex items-center gap-4 text-sm text-muted-foreground">
					<div className="flex items-center gap-3">
						{isRunning ? (
							<div className="flex items-center gap-1">
								<Loader2 className="h-3 w-3 animate-spin" style={{ color: themeGradient.from }} />
								<span>Searching...</span>
							</div>
						) : (
							<>
								<div className="flex items-center gap-1" title="Items searched">
									<ListChecks className="h-3.5 w-3.5" />
									<span>{log.itemsSearched} searched</span>
								</div>
								<div
									className={`flex items-center gap-1 ${log.itemsGrabbed > 0 ? "text-green-500" : ""}`}
									title={log.itemsGrabbed > 0 ? "Items grabbed" : "No releases grabbed"}
								>
									<Download className="h-3.5 w-3.5" />
									<span>{log.itemsGrabbed} grabbed</span>
								</div>
							</>
						)}
					</div>
					<div className="text-xs">
						{isRunning ? (
							<span style={{ color: themeGradient.from }}>
								Started {formatTime(log.startedAt)}
							</span>
						) : (
							formatTime(log.startedAt)
						)}
					</div>
					{/* Expand indicator */}
					{expanded ? (
						<ChevronUp className="h-4 w-4 text-muted-foreground" />
					) : (
						<ChevronDown className="h-4 w-4 text-muted-foreground" />
					)}
				</div>
			</button>

			{/* Expanded Details */}
			{expanded && (
				<div className="px-4 py-4 border-t border-border/30 bg-muted/10 text-sm space-y-4">
					{/* Message */}
					{log.message && (
						<p className="text-muted-foreground">{log.message}</p>
					)}

					{/* Metadata */}
					<div className="flex flex-wrap gap-4 text-xs text-muted-foreground">
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
										<span className="font-medium text-foreground flex-1">
											{item.title}
										</span>
										{item.quality && (
											<StatusBadge status="success">{item.quality}</StatusBadge>
										)}
										{item.indexer && (
											<span className="text-muted-foreground">{item.indexer}</span>
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
									<div className="text-xs text-muted-foreground pl-3">
										+{log.grabbedItems.length - 10} more grabbed
									</div>
								)}
							</div>
						</div>
					)}

					{/* Searched Items */}
					{log.searchedItems && log.searchedItems.length > 0 && (
						<div>
							<h4 className="text-xs font-semibold text-muted-foreground mb-2">
								Searched Items:
							</h4>
							<div className="flex flex-wrap gap-1.5">
								{log.searchedItems.slice(0, 10).map((item, i) => (
									<span
										key={i}
										className="text-xs px-2 py-1 rounded-md bg-muted/50 text-muted-foreground"
									>
										{item}
									</span>
								))}
								{log.searchedItems.length > 10 && (
									<span className="text-xs px-2 py-1 rounded-md bg-muted/50 text-muted-foreground">
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
	return `${parseFloat((bytes / Math.pow(k, i)).toFixed(1))} ${sizes[i]}`;
}
