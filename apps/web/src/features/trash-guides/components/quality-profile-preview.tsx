/**
 * Quality Profile Preview Component
 *
 * Preview deployment of complete quality profile
 * - Show quality definitions and cutoffs
 * - Display custom format matching
 * - Show format scores
 * - Warn about unmatched CFs
 */

"use client";

import { useEffect, useRef } from "react";
import { Alert, AlertDescription } from "../../../components/ui/alert";
import { usePreviewProfileDeployment } from "../../../hooks/api/useProfileClone";
import type { CompleteQualityProfile } from "@arr/shared";
import {
	CheckCircle,
	AlertCircle,
	Info,
	TrendingUp,
	Target,
	Award,
} from "lucide-react";

interface QualityProfilePreviewProps {
	instanceId: string;
	profile: CompleteQualityProfile;
	customFormats: Array<{ trash_id: string; score: number }>;
	onPreviewReady?: (hasWarnings: boolean) => void;
}

export function QualityProfilePreview({
	instanceId,
	profile,
	customFormats,
	onPreviewReady,
}: QualityProfilePreviewProps) {
	const previewMutation = usePreviewProfileDeployment();

	// Track previous values for deep comparison
	const prevDataRef = useRef<{
		instanceId: string;
		profileKey: string;
		formatsKey: string;
	} | null>(null);

	useEffect(() => {
		// Create stable keys for comparison (computed once per effect, not every render)
		const profileKey = `${profile.sourceProfileId}-${profile.sourceInstanceId}-${JSON.stringify(profile.items)}`;
		const formatsKey = JSON.stringify(customFormats);

		// Skip if data hasn't changed
		if (
			prevDataRef.current?.instanceId === instanceId &&
			prevDataRef.current?.profileKey === profileKey &&
			prevDataRef.current?.formatsKey === formatsKey
		) {
			return;
		}

		// Update ref and trigger mutation
		prevDataRef.current = { instanceId, profileKey, formatsKey };
		previewMutation.mutate({
			instanceId,
			profile,
			customFormats,
		});
	}, [instanceId, profile, customFormats, previewMutation]);

	useEffect(() => {
		if (previewMutation.isSuccess && previewMutation.data) {
			const hasWarnings = previewMutation.data.customFormats.unmatched.length > 0;
			onPreviewReady?.(hasWarnings);
		}
	}, [previewMutation.isSuccess, previewMutation.data, onPreviewReady]);

	if (previewMutation.isPending) {
		return (
			<div className="rounded border border-border/30 p-4 bg-bg-subtle/40">
				<div className="text-sm text-fg-muted">Loading preview...</div>
			</div>
		);
	}

	if (previewMutation.isError) {
		return (
			<Alert variant="danger">
				<AlertCircle className="h-4 w-4" />
				<AlertDescription className="text-xs">
					{previewMutation.error instanceof Error
						? previewMutation.error.message
						: "Failed to generate preview"}
				</AlertDescription>
			</Alert>
		);
	}

	if (!previewMutation.data) {
		return null;
	}

	const preview = previewMutation.data;
	const hasUnmatched = preview.customFormats.unmatched.length > 0;

	return (
		<div className="space-y-4">
			<h4 className="text-sm font-medium text-fg">Deployment Preview</h4>

			{/* Quality Definitions */}
			<div className="rounded border border-border/30 p-4 bg-bg-subtle/40 space-y-3">
				<div className="flex items-center gap-2">
					<Target className="h-4 w-4 text-fg-muted" />
					<span className="font-medium text-fg">Quality Definitions</span>
				</div>

				<div className="grid grid-cols-2 gap-3 text-sm">
					<div>
						<span className="text-fg-muted">Cutoff Quality:</span>
						<div className="font-medium text-fg">
							{preview.qualityDefinitions.cutoff}
						</div>
					</div>
					<div>
						<span className="text-fg-muted">Upgrade Allowed:</span>
						<div className="font-medium text-fg">
							{preview.qualityDefinitions.upgradeAllowed ? (
								<span className="text-success">Yes</span>
							) : (
								<span className="text-fg-muted">No</span>
							)}
						</div>
					</div>
					<div>
						<span className="text-fg-muted">Total Qualities:</span>
						<div className="font-medium text-fg">
							{preview.qualityDefinitions.totalQualities}
						</div>
					</div>
					<div>
						<span className="text-fg-muted">Allowed Qualities:</span>
						<div className="font-medium text-fg">
							{preview.qualityDefinitions.allowedQualities}
						</div>
					</div>
				</div>
			</div>

			{/* Custom Formats */}
			<div className="rounded border border-border/30 p-4 bg-bg-subtle/40 space-y-3">
				<div className="flex items-center gap-2">
					<Award className="h-4 w-4 text-fg-muted" />
					<span className="font-medium text-fg">Custom Formats</span>
				</div>

				<div className="grid grid-cols-3 gap-3 text-sm">
					<div>
						<span className="text-fg-muted">Total Selected:</span>
						<div className="font-medium text-fg">
							{preview.customFormats.total}
						</div>
					</div>
					<div>
						<span className="text-fg-muted">Matched:</span>
						<div className="font-medium text-success">
							{preview.customFormats.matched}
						</div>
					</div>
					<div>
						<span className="text-fg-muted">Unmatched:</span>
						<div
							className={`font-medium ${
								hasUnmatched ? "text-warning" : "text-fg-muted"
							}`}
						>
							{preview.customFormats.unmatched.length}
						</div>
					</div>
				</div>

				{hasUnmatched && (
					<Alert variant="warning" className="mt-3">
						<AlertCircle className="h-4 w-4" />
						<AlertDescription className="text-xs">
							<div className="font-medium mb-1">
								The following custom formats were not found on the target
								instance:
							</div>
							<ul className="list-disc list-inside space-y-0.5">
								{preview.customFormats.unmatched.map((cf) => (
									<li key={cf}>{cf}</li>
								))}
							</ul>
							<div className="mt-2 text-xs">
								These custom formats will need to be created on the instance
								before deployment, or they will be skipped.
							</div>
						</AlertDescription>
					</Alert>
				)}
			</div>

			{/* Format Scores */}
			<div className="rounded border border-border/30 p-4 bg-bg-subtle/40 space-y-3">
				<div className="flex items-center gap-2">
					<TrendingUp className="h-4 w-4 text-fg-muted" />
					<span className="font-medium text-fg">Format Scores</span>
				</div>

				<div className="grid grid-cols-3 gap-3 text-sm">
					<div>
						<span className="text-fg-muted">Minimum Score:</span>
						<div className="font-medium text-fg">
							{preview.formatScores.minScore}
						</div>
					</div>
					<div>
						<span className="text-fg-muted">Cutoff Score:</span>
						<div className="font-medium text-fg">
							{preview.formatScores.cutoffScore}
						</div>
					</div>
					<div>
						<span className="text-fg-muted">Average Score:</span>
						<div className="font-medium text-fg">
							{preview.formatScores.avgScore}
						</div>
					</div>
				</div>
			</div>

			{/* Success Info */}
			{!hasUnmatched && (
				<Alert>
					<CheckCircle className="h-4 w-4 text-success" />
					<AlertDescription className="text-xs">
						All custom formats were matched successfully. Profile is ready to
						deploy.
					</AlertDescription>
				</Alert>
			)}
		</div>
	);
}
