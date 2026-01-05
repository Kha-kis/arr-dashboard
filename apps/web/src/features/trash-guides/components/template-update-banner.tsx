"use client";

import { useState } from "react";
import { RefreshCw, Clock, AlertCircle, CheckCircle2, ChevronDown, ChevronUp, History } from "lucide-react";
import type { TemplateUpdateInfo } from "../../../lib/api-client/trash-guides";
import { cn } from "../../../lib/utils";
import { THEME_GRADIENTS } from "../../../lib/theme-gradients";
import { useColorTheme } from "../../../providers/color-theme-provider";
import { TemplateDiffModal } from "./template-diff-modal";

interface TemplateUpdateBannerProps {
	update: TemplateUpdateInfo;
	onSyncSuccess?: () => void;
}

// Format relative time for display
const formatRelativeTime = (timestamp: string | undefined): string => {
	if (!timestamp) return "";
	const date = new Date(timestamp);
	const now = new Date();
	const diffMs = now.getTime() - date.getTime();
	const diffMins = Math.floor(diffMs / 60000);
	const diffHours = Math.floor(diffMs / 3600000);
	const diffDays = Math.floor(diffMs / 86400000);

	if (diffMins < 1) return "just now";
	if (diffMins < 60) return `${diffMins}m ago`;
	if (diffHours < 24) return `${diffHours}h ago`;
	return `${diffDays}d ago`;
};

export const TemplateUpdateBanner = ({
	update,
	onSyncSuccess,
}: TemplateUpdateBannerProps) => {
	const { colorTheme } = useColorTheme();
	const themeGradient = THEME_GRADIENTS[colorTheme];
	const [showDetails, setShowDetails] = useState(false);
	const [showDiffModal, setShowDiffModal] = useState(false);

	const isRecentlyAutoSynced = update.isRecentlyAutoSynced ?? false;

	const handleViewChanges = () => {
		setShowDiffModal(true);
	};

	const handleDiffModalClose = () => {
		setShowDiffModal(false);
	};

	// Different styling for recently synced vs pending updates
	// Green for synced (semantic), theme color for pending
	const getBannerStyle = (): React.CSSProperties | undefined => {
		if (isRecentlyAutoSynced) return undefined;
		return {
			borderColor: themeGradient.fromMuted,
			backgroundColor: themeGradient.fromLight,
		};
	};

	const bannerColorClasses = isRecentlyAutoSynced
		? "border-green-500/30 bg-green-500/10"
		: "";

	const iconColorClasses = isRecentlyAutoSynced
		? "text-green-500"
		: "";

	const getIconStyle = (): React.CSSProperties | undefined => {
		if (isRecentlyAutoSynced) return undefined;
		return { color: themeGradient.from };
	};

	const getButtonStyle = (): React.CSSProperties | undefined => {
		if (isRecentlyAutoSynced) return undefined;
		return { backgroundColor: themeGradient.from };
	};

	const buttonColorClasses = isRecentlyAutoSynced
		? "bg-green-600 hover:bg-green-700"
		: "hover:opacity-90";

	return (
		<div className={cn("rounded-lg border p-3", bannerColorClasses)} style={getBannerStyle()}>
			{/* Top row: icon, message, badges, more button */}
			<div className="flex items-center gap-3">
				{isRecentlyAutoSynced ? (
					<History className={cn("h-4 w-4 shrink-0", iconColorClasses)} />
				) : (
					<RefreshCw className="h-4 w-4 shrink-0" style={getIconStyle()} />
				)}

				{/* Message */}
				<span className="text-sm font-medium text-fg">
					{isRecentlyAutoSynced ? "Recently Auto-Synced" : "Update Available"}
				</span>

				{/* Badges */}
				<div className="flex items-center gap-1.5 flex-1">
					{/* Show timestamp for recently synced */}
					{isRecentlyAutoSynced && update.lastAutoSyncTimestamp && (
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
					{!isRecentlyAutoSynced && (update.autoSyncInstanceCount ?? 0) > 0 && (
						<span className="inline-flex items-center gap-1 px-2 py-0.5 rounded text-xs font-medium bg-green-500/20 text-green-600 dark:text-green-400">
							<CheckCircle2 className="h-3 w-3" />
							{update.autoSyncInstanceCount} auto-sync
						</span>
					)}
				</div>

				{/* More/Less button */}
				<button
					type="button"
					onClick={() => setShowDetails(!showDetails)}
					className="inline-flex items-center gap-1 px-2 py-1 text-xs font-medium text-fg-muted hover:text-fg hover:bg-bg-subtle rounded transition-colors shrink-0"
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

			{/* Action button row */}
			<div className="mt-3 flex justify-center">
				<button
					type="button"
					onClick={handleViewChanges}
					className={cn(
						"px-4 py-1.5 text-xs font-medium text-primary-fg rounded transition-colors",
						buttonColorClasses
					)}
					style={getButtonStyle()}
				>
					{isRecentlyAutoSynced ? "View Recent Changes" : "View Changes"}
				</button>
			</div>

			{/* Expandable details */}
			{showDetails && (
				<div
					className={cn(
						"mt-3 pt-3 border-t",
						isRecentlyAutoSynced && "border-green-500/20"
					)}
					style={!isRecentlyAutoSynced ? { borderColor: themeGradient.fromMuted } : undefined}
				>
					<div className="flex flex-wrap gap-x-6 gap-y-2 text-xs text-fg-muted">
						<div className="flex items-center gap-1.5">
							<Clock className="h-3 w-3" />
							<span>{isRecentlyAutoSynced ? "Version:" : "Current:"}</span>
							<code className="px-1.5 py-0.5 rounded bg-black/10 dark:bg-white/10 font-mono text-fg">
								{update.currentCommit?.substring(0, 8) || "unknown"}
							</code>
						</div>
						{!isRecentlyAutoSynced && (
							<div className="flex items-center gap-1.5">
								<RefreshCw className="h-3 w-3" />
								<span>Latest:</span>
								<code className="px-1.5 py-0.5 rounded bg-black/10 dark:bg-white/10 font-mono text-fg">
									{update.latestCommit.substring(0, 8)}
								</code>
							</div>
						)}
						{isRecentlyAutoSynced && (
							<div className="flex items-center gap-1.5 text-green-600 dark:text-green-400">
								<CheckCircle2 className="h-3 w-3" />
								<span>Up to date with TRaSH Guides</span>
							</div>
						)}
						{!isRecentlyAutoSynced && update.canAutoSync && (
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
				onClose={handleDiffModalClose}
				templateId={showDiffModal ? update.templateId : null}
				templateName={update.templateName}
				onSyncSuccess={() => {
					handleDiffModalClose();
					onSyncSuccess?.();
				}}
			/>
		</div>
	);
};
