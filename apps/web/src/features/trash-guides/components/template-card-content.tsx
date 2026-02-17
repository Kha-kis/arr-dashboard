"use client";

/**
 * Template Card Content
 *
 * Renders the content of a single template card:
 * header, quality badges, stats, deploy button, and action buttons.
 */

import type { TrashTemplate } from "@arr/shared";
import { Copy, Download, Edit, Rocket, Trash2 } from "lucide-react";
import { SEMANTIC_COLORS, getServiceGradient } from "../../../lib/theme-gradients";
import { TemplateStats } from "./template-stats";
import { TemplateUpdateBanner } from "./template-update-banner";
import type { TemplateUpdateInfo } from "../../../lib/api-client/trash-guides";

interface TemplateCardContentProps {
	template: TrashTemplate;
	themeGradient: { from: string; to: string; glow: string };
	templateUpdate: TemplateUpdateInfo | undefined;
	onEdit: () => void;
	onDeploy: (instanceId: string, instanceLabel: string) => void;
	onUnlinkInstance: (instanceId: string, instanceName: string) => void;
	onOpenInstanceSelector: () => void;
	onOpenDuplicate: () => void;
	onOpenExport: () => void;
	onOpenDelete: () => void;
}

export const TemplateCardContent = ({
	template,
	themeGradient,
	templateUpdate,
	onEdit,
	onDeploy,
	onUnlinkInstance,
	onOpenInstanceSelector,
	onOpenDuplicate,
	onOpenExport,
	onOpenDelete,
}: TemplateCardContentProps) => (
	<div className="flex flex-1 flex-col">
		{/* Header */}
		<div className="space-y-3 mb-4">
			<div className="flex items-start justify-between">
				<div>
					<h3 className="font-semibold text-foreground">{template.name}</h3>
					<p
						className="mt-1 text-xs font-medium"
						style={{ color: getServiceGradient(template.serviceType).from }}
					>
						{template.serviceType}
					</p>
				</div>
				<span className="text-xs text-muted-foreground">
					{template.updatedAt ? new Date(template.updatedAt).toLocaleDateString() : ""}
				</span>
			</div>

			{template.description && (
				<p className="text-sm text-muted-foreground line-clamp-2">{template.description}</p>
			)}

			<div className="space-y-2">
				<div className="flex items-center gap-2 text-xs text-muted-foreground">
					<span>{template.config.customFormats.length} formats</span>
					<span className="text-border">•</span>
					<span>{template.config.customFormatGroups.length} groups</span>
				</div>
				{template.config.qualityProfile && (
					<div className="flex flex-wrap gap-1.5">
						{template.config.qualityProfile.language && (
							<span
								className="inline-flex items-center gap-1 rounded-lg px-2 py-0.5 text-xs font-medium"
								style={{
									backgroundColor: `${themeGradient.from}15`,
									border: `1px solid ${themeGradient.from}25`,
									color: themeGradient.from,
								}}
							>
								🌐 {template.config.qualityProfile.language}
							</span>
						)}
						{template.config.qualityProfile.trash_score_set && (
							<span className="inline-flex items-center gap-1 rounded-lg bg-purple-500/15 border border-purple-500/25 px-2 py-0.5 text-xs font-medium text-purple-400">
								📊 {template.config.qualityProfile.trash_score_set}
							</span>
						)}
						{template.config.qualityProfile.cutoff && (
							<span
								className="inline-flex items-center gap-1 rounded-lg px-2 py-0.5 text-xs font-medium"
								style={{
									backgroundColor: SEMANTIC_COLORS.success.bg,
									border: `1px solid ${SEMANTIC_COLORS.success.border}`,
									color: SEMANTIC_COLORS.success.text,
								}}
							>
								🎬 {template.config.qualityProfile.cutoff}
							</span>
						)}
					</div>
				)}
			</div>

			{/* Update Banner */}
			{templateUpdate && <TemplateUpdateBanner update={templateUpdate} />}
		</div>

		{/* Fixed Bottom Section */}
		<div className="mt-auto space-y-3 pt-3 border-t border-border/30">
			<TemplateStats
				templateId={template.id}
				templateName={template.name}
				onDeploy={onDeploy}
				onUnlinkInstance={onUnlinkInstance}
			/>

			{/* Deploy Button */}
			<button
				type="button"
				onClick={onOpenInstanceSelector}
				className="w-full inline-flex items-center justify-center gap-2 rounded-xl px-4 py-2.5 text-sm font-medium transition-all duration-200"
				style={{
					background: `linear-gradient(135deg, ${themeGradient.from}, ${themeGradient.to})`,
					boxShadow: `0 4px 12px -4px ${themeGradient.glow}`,
				}}
			>
				<Rocket className="h-4 w-4" />
				Deploy to Instance
			</button>

			{/* Action Buttons */}
			<div className="flex gap-2">
				<button
					type="button"
					onClick={onEdit}
					className="flex-1 rounded-xl p-2.5 border border-border/50 bg-card/30 hover:bg-card/50 transition-all"
					aria-label={`Edit template ${template.name}`}
					title="Edit template"
				>
					<Edit className="mx-auto h-4 w-4" />
				</button>
				<button
					type="button"
					onClick={onOpenDuplicate}
					className="flex-1 rounded-xl p-2.5 border border-border/50 bg-card/30 hover:bg-card/50 transition-all"
					aria-label={`Duplicate template ${template.name}`}
					title="Duplicate template"
				>
					<Copy className="mx-auto h-4 w-4" />
				</button>
				<button
					type="button"
					onClick={onOpenExport}
					className="flex-1 rounded-xl p-2.5 border border-border/50 bg-card/30 hover:bg-card/50 transition-all"
					aria-label={`Export template ${template.name}`}
					title="Export template"
				>
					<Download className="mx-auto h-4 w-4" />
				</button>
				<button
					type="button"
					onClick={onOpenDelete}
					className="flex-1 rounded-xl p-2.5 transition-all"
					style={{
						backgroundColor: SEMANTIC_COLORS.error.bg,
						border: `1px solid ${SEMANTIC_COLORS.error.border}`,
						color: SEMANTIC_COLORS.error.text,
					}}
					aria-label={`Delete template ${template.name}`}
					title="Delete template"
				>
					<Trash2 className="mx-auto h-4 w-4" />
				</button>
			</div>
		</div>
	</div>
);
