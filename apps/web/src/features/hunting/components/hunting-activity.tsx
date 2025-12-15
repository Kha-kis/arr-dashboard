"use client";

import { useState } from "react";
import {
	EmptyState,
	Badge,
	Select,
	SelectOption,
	Pagination,
} from "../../../components/ui";
import { Section } from "../../../components/layout";
import { Activity, Search, ArrowUpCircle, CheckCircle2, AlertCircle, Clock, Download } from "lucide-react";
import { useHuntingLogs } from "../hooks/useHuntingLogs";
import type { HuntLog } from "../lib/hunting-types";

export const HuntingActivity = () => {
	const [typeFilter, setTypeFilter] = useState<string>("all");
	const [statusFilter, setStatusFilter] = useState<string>("all");
	const [page, setPage] = useState(1);
	const [pageSize, setPageSize] = useState(20);

	const { logs, totalCount, isLoading, error } = useHuntingLogs({
		type: typeFilter === "all" ? undefined : typeFilter,
		status: statusFilter === "all" ? undefined : statusFilter,
		page,
		pageSize,
	});

	if (isLoading) {
		return (
			<Section title="Hunt Activity Log">
				<div className="space-y-4">
					{Array.from({ length: 5 }).map((_, i) => (
						<div key={i} className="h-16 bg-bg-subtle animate-pulse rounded-lg" />
					))}
				</div>
			</Section>
		);
	}

	if (error) {
		return (
			<EmptyState
				icon={AlertCircle}
				title="Failed to load activity"
				description="Could not fetch hunting activity logs. Please try again."
			/>
		);
	}

	return (
		<Section
			title="Hunt Activity Log"
			description="Recent hunting activity across all instances"
		>
			{/* Filters */}
			<div className="flex flex-wrap gap-4 mb-6">
				<Select
					value={typeFilter}
					onChange={(e) => {
						setTypeFilter(e.target.value);
						setPage(1);
					}}
				>
					<SelectOption value="all">All Types</SelectOption>
					<SelectOption value="missing">Missing Content</SelectOption>
					<SelectOption value="upgrade">Quality Upgrades</SelectOption>
				</Select>

				<Select
					value={statusFilter}
					onChange={(e) => {
						setStatusFilter(e.target.value);
						setPage(1);
					}}
				>
					<SelectOption value="all">All Status</SelectOption>
					<SelectOption value="completed">Completed</SelectOption>
					<SelectOption value="partial">Partial</SelectOption>
					<SelectOption value="skipped">Skipped</SelectOption>
					<SelectOption value="error">Error</SelectOption>
				</Select>
			</div>

			{logs.length === 0 ? (
				<EmptyState
					icon={Activity}
					title="No activity yet"
					description="Hunt activity will appear here once hunting is configured and running."
				/>
			) : (
				<>
					<div className="space-y-3">
						{logs.map((log) => (
							<ActivityLogEntry key={log.id} log={log} />
						))}
					</div>

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
		</Section>
	);
};

interface ActivityLogEntryProps {
	log: HuntLog;
}

const ActivityLogEntry = ({ log }: ActivityLogEntryProps) => {
	const [expanded, setExpanded] = useState(false);
	const Icon = log.huntType === "missing" ? Search : ArrowUpCircle;

	type BadgeVariant = "success" | "warning" | "danger" | "default" | "info";
	const statusConfig: Record<string, { variant: BadgeVariant; icon: React.ElementType }> = {
		completed: { variant: "success", icon: CheckCircle2 },
		partial: { variant: "warning", icon: AlertCircle },
		skipped: { variant: "default", icon: Clock },
		error: { variant: "danger", icon: AlertCircle },
	};

	const statusInfo = statusConfig[log.status] ?? statusConfig.error!;
	const StatusIcon = statusInfo.icon;

	return (
		<div className="rounded-lg border border-border bg-bg-subtle/30 overflow-hidden">
			<button
				type="button"
				onClick={() => setExpanded(!expanded)}
				className="w-full px-4 py-3 flex items-center justify-between hover:bg-bg-subtle/50 transition"
			>
				<div className="flex items-center gap-3">
					<Icon className="h-4 w-4 text-fg-muted" />
					<div className="text-left">
						<div className="flex items-center gap-2">
							<span className="font-medium text-fg">{log.instanceName}</span>
							<Badge variant={log.service === "sonarr" ? "info" : "warning"} className="text-xs">
								{log.service}
							</Badge>
							<Badge variant={statusInfo.variant} className="text-xs">
								<StatusIcon className="h-3 w-3 mr-1" />
								{log.status}
							</Badge>
						</div>
						<div className="text-xs text-fg-muted mt-0.5">
							{log.huntType === "missing" ? "Missing content search" : "Quality upgrade search"}
						</div>
					</div>
				</div>

				<div className="flex items-center gap-4 text-sm text-fg-muted">
					<div className="flex items-center gap-1">
						<Search className="h-3 w-3" />
						<span>{log.itemsSearched}</span>
					</div>
					<div className="flex items-center gap-1">
						<Download className="h-3 w-3" />
						<span>{log.itemsFound}</span>
					</div>
					<div className="text-xs">
						{formatTime(log.startedAt)}
					</div>
				</div>
			</button>

			{expanded && (
				<div className="px-4 py-3 border-t border-border bg-bg-subtle/50 text-sm">
					{log.message && (
						<p className="text-fg-muted mb-2">{log.message}</p>
					)}

					<div className="flex flex-wrap gap-4 text-xs text-fg-muted">
						{log.durationMs && (
							<span>Duration: {(log.durationMs / 1000).toFixed(1)}s</span>
						)}
						<span>Started: {new Date(log.startedAt).toLocaleString()}</span>
						{log.completedAt && (
							<span>Completed: {new Date(log.completedAt).toLocaleString()}</span>
						)}
					</div>

					{log.foundItems && log.foundItems.length > 0 && (
						<div className="mt-3">
							<h4 className="text-xs font-medium text-fg-muted mb-2">Found Items:</h4>
							<div className="flex flex-wrap gap-1">
								{log.foundItems.slice(0, 10).map((item, i) => (
									<Badge key={i} variant="default" className="text-xs">
										{item}
									</Badge>
								))}
								{log.foundItems.length > 10 && (
									<Badge variant="default" className="text-xs">
										+{log.foundItems.length - 10} more
									</Badge>
								)}
							</div>
						</div>
					)}
				</div>
			)}
		</div>
	);
};

function formatTime(dateString: string): string {
	const date = new Date(dateString);
	return date.toLocaleTimeString(undefined, { hour: "2-digit", minute: "2-digit" });
}
