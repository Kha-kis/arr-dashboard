"use client";

import { useState } from "react";
import { RefreshCw, Clock, AlertCircle, CheckCircle2, ChevronDown, ChevronUp } from "lucide-react";
import type { TemplateUpdateInfo } from "../../../lib/api-client/trash-guides";
import { cn } from "../../../lib/utils";
import { TemplateDiffModal } from "./template-diff-modal";

interface TemplateUpdateBannerProps {
	update: TemplateUpdateInfo;
	onSyncSuccess?: () => void;
}

export const TemplateUpdateBanner = ({
	update,
	onSyncSuccess,
}: TemplateUpdateBannerProps) => {
	const [showDetails, setShowDetails] = useState(false);
	const [showDiffModal, setShowDiffModal] = useState(false);

	const handleViewChanges = () => {
		setShowDiffModal(true);
	};

	const handleDiffModalClose = () => {
		setShowDiffModal(false);
	};

	return (
		<div className="rounded-lg border border-blue-500/30 bg-blue-500/10 p-3">
			{/* Top row: icon, message, badges, more button */}
			<div className="flex items-center gap-3">
				<RefreshCw className="h-4 w-4 text-blue-500 shrink-0" />

				{/* Message */}
				<span className="text-sm font-medium text-fg">
					Update Available
				</span>

				{/* Badges */}
				<div className="flex items-center gap-1.5 flex-1">
					{update.hasUserModifications && (
						<span className="inline-flex items-center gap-1 px-2 py-0.5 rounded text-xs font-medium bg-amber-500/20 text-amber-600 dark:text-amber-400">
							<AlertCircle className="h-3 w-3" />
							Modified
						</span>
					)}
					{(update.autoSyncInstanceCount ?? 0) > 0 && (
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
					className="px-4 py-1.5 text-xs font-medium bg-blue-600 text-primary-fg hover:bg-blue-700 rounded transition-colors"
				>
					View Changes
				</button>
			</div>

			{/* Expandable details */}
			{showDetails && (
				<div className="mt-3 pt-3 border-t border-blue-500/20">
					<div className="flex flex-wrap gap-x-6 gap-y-2 text-xs text-fg-muted">
						<div className="flex items-center gap-1.5">
							<Clock className="h-3 w-3" />
							<span>Current:</span>
							<code className="px-1.5 py-0.5 rounded bg-black/10 dark:bg-white/10 font-mono text-fg">
								{update.currentCommit?.substring(0, 8) || "unknown"}
							</code>
						</div>
						<div className="flex items-center gap-1.5">
							<RefreshCw className="h-3 w-3" />
							<span>Latest:</span>
							<code className="px-1.5 py-0.5 rounded bg-black/10 dark:bg-white/10 font-mono text-fg">
								{update.latestCommit.substring(0, 8)}
							</code>
						</div>
						{update.canAutoSync && (
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
