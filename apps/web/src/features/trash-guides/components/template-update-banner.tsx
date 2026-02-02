"use client";

import { useState } from "react";
import { RefreshCw, Clock, AlertCircle, CheckCircle2, ChevronDown, ChevronUp, History } from "lucide-react";
import type { TemplateUpdateInfo } from "../../../lib/api-client/trash-guides";
import { cn } from "../../../lib/utils";
import { useThemeGradient } from "../../../hooks/useThemeGradient";
import { TemplateDiffModal } from "./template-diff-modal";

interface TemplateUpdateBannerProps {
	update: TemplateUpdateInfo;
	onSyncSuccess?: () => void;
}

function formatRelativeTime(timestamp: string | undefined): string {
	if (!timestamp) return "";
	const diffMs = Date.now() - new Date(timestamp).getTime();
	const diffMins = Math.floor(diffMs / 60000);
	const diffHours = Math.floor(diffMs / 3600000);
	const diffDays = Math.floor(diffMs / 86400000);

	if (diffMins < 1) return "just now";
	if (diffMins < 60) return `${diffMins}m ago`;
	if (diffHours < 24) return `${diffHours}h ago`;
	return `${diffDays}d ago`;
}

export function TemplateUpdateBanner({
	update,
	onSyncSuccess,
}: TemplateUpdateBannerProps) {
	const { gradient: themeGradient } = useThemeGradient();
	const [showDetails, setShowDetails] = useState(false);
	const [showDiffModal, setShowDiffModal] = useState(false);

	const isSynced = update.isRecentlyAutoSynced ?? false;

	// Green semantic styles for synced, theme-colored styles for pending
	const bannerStyle: React.CSSProperties | undefined = isSynced
		? undefined
		: { borderColor: themeGradient.fromMuted, backgroundColor: themeGradient.fromLight };

	const bannerClasses = isSynced ? "border-green-500/30 bg-green-500/10" : "";
	const iconStyle: React.CSSProperties | undefined = isSynced ? undefined : { color: themeGradient.from };
	const buttonStyle: React.CSSProperties | undefined = isSynced ? undefined : { backgroundColor: themeGradient.from };
	const buttonClasses = isSynced ? "bg-green-600 hover:bg-green-700" : "hover:opacity-90";

	return (
		<div className={cn("rounded-lg border p-3 overflow-hidden", bannerClasses)} style={bannerStyle}>
			{/* Top row: icon, message, more button */}
			<div className="flex items-center gap-2">
				{isSynced ? (
					<History className="h-4 w-4 shrink-0 text-green-500" />
				) : (
					<RefreshCw className="h-4 w-4 shrink-0" style={iconStyle} />
				)}

				<span className="text-sm font-medium text-foreground truncate">
					{isSynced ? "Recently Auto-Synced" : "Update Available"}
				</span>

				<div className="flex-1" />

				<button
					type="button"
					onClick={() => setShowDetails(!showDetails)}
					className="inline-flex items-center gap-1 px-2 py-1 text-xs font-medium text-muted-foreground hover:text-foreground hover:bg-card rounded transition-colors shrink-0"
				>
					{showDetails ? (
						<>
							<ChevronUp className="h-3 w-3" />
							Less
						</>
					) : (
						<>
							<ChevronDown className="h-3 w-3" />
							More
						</>
					)}
				</button>
			</div>

			{/* Badges row (below to avoid overflow in narrow cards) */}
			<div className="flex items-center gap-1.5 flex-wrap mt-2">
				{isSynced && update.lastAutoSyncTimestamp && (
					<span className="inline-flex items-center gap-1 px-2 py-0.5 rounded text-xs font-medium bg-green-500/20 text-green-600 dark:text-green-400">
						<Clock className="h-3 w-3" />
						{formatRelativeTime(update.lastAutoSyncTimestamp)}
					</span>
				)}
				{update.hasUserModifications && (
					<span className="inline-flex items-center gap-1 px-2 py-0.5 rounded text-xs font-medium bg-amber-500/20 text-amber-600 dark:text-amber-400">
						<AlertCircle className="h-3 w-3" />
						Modified
					</span>
				)}
				{!isSynced && (update.autoSyncInstanceCount ?? 0) > 0 && (
					<span className="inline-flex items-center gap-1 px-2 py-0.5 rounded text-xs font-medium bg-green-500/20 text-green-600 dark:text-green-400">
						<CheckCircle2 className="h-3 w-3" />
						{update.autoSyncInstanceCount} auto-sync
					</span>
				)}
			</div>

			{/* Action button row */}
			<div className="mt-3 flex justify-center">
				<button
					type="button"
					onClick={() => setShowDiffModal(true)}
					className={cn(
						"px-4 py-1.5 text-xs font-medium text-primary-fg rounded transition-colors",
						buttonClasses
					)}
					style={buttonStyle}
				>
					{isSynced ? "View Recent Changes" : "View Changes"}
				</button>
			</div>

			{/* Expandable details */}
			{showDetails && (
				<div
					className={cn(
						"mt-3 pt-3 border-t",
						isSynced && "border-green-500/20"
					)}
					style={!isSynced ? { borderColor: themeGradient.fromMuted } : undefined}
				>
					<div className="flex flex-wrap gap-x-6 gap-y-2 text-xs text-muted-foreground">
						<div className="flex items-center gap-1.5">
							<Clock className="h-3 w-3" />
							<span>{isSynced ? "Version:" : "Current:"}</span>
							<code className="px-1.5 py-0.5 rounded bg-black/10 dark:bg-white/10 font-mono text-foreground">
								{update.currentCommit?.substring(0, 8) || "unknown"}
							</code>
						</div>
						{!isSynced && (
							<div className="flex items-center gap-1.5">
								<RefreshCw className="h-3 w-3" />
								<span>Latest:</span>
								<code className="px-1.5 py-0.5 rounded bg-black/10 dark:bg-white/10 font-mono text-foreground">
									{update.latestCommit.substring(0, 8)}
								</code>
							</div>
						)}
						{isSynced && (
							<div className="flex items-center gap-1.5 text-green-600 dark:text-green-400">
								<CheckCircle2 className="h-3 w-3" />
								<span>Up to date with TRaSH Guides</span>
							</div>
						)}
						{!isSynced && update.canAutoSync && (
							<div className="flex items-center gap-1.5 text-green-600 dark:text-green-400">
								<CheckCircle2 className="h-3 w-3" />
								<span>Eligible for auto-sync</span>
							</div>
						)}
					</div>
				</div>
			)}

			<TemplateDiffModal
				open={showDiffModal}
				onClose={() => setShowDiffModal(false)}
				templateId={showDiffModal ? update.templateId : null}
				templateName={update.templateName}
				onSyncSuccess={() => {
					setShowDiffModal(false);
					onSyncSuccess?.();
				}}
			/>
		</div>
	);
}
