"use client";

import type { SeerrRequest } from "@arr/shared";
import { SEERR_MEDIA_STATUS, SEERR_REQUEST_STATUS } from "@arr/shared";
import { Check, Circle, Clock, X } from "lucide-react";
import { SEMANTIC_COLORS } from "../../../lib/theme-gradients";
import { formatRelativeTime } from "../lib/seerr-utils";

// ============================================================================
// Types
// ============================================================================

interface RequestStatusTimelineProps {
	request: SeerrRequest;
	variant: "compact" | "expanded";
	/** Display name of the modifier (already anonymized if incognito) */
	modifierName?: string;
}

type StageStatus = "completed" | "active" | "upcoming" | "failed";

interface TimelineStage {
	label: string;
	status: StageStatus;
	/** Only set when we have a confident timestamp */
	timestamp?: string;
	/** Actor attribution (e.g., "by admin") */
	actor?: string;
}

// ============================================================================
// Stage colors
// ============================================================================

const STAGE_COLORS: Record<StageStatus, { dot: string; line: string; text: string }> = {
	completed: {
		dot: SEMANTIC_COLORS.success.from,
		line: SEMANTIC_COLORS.success.from,
		text: SEMANTIC_COLORS.success.text,
	},
	active: {
		dot: SEMANTIC_COLORS.info.from,
		line: SEMANTIC_COLORS.info.from,
		text: SEMANTIC_COLORS.info.text,
	},
	upcoming: {
		dot: "rgba(100, 116, 139, 0.3)",
		line: "rgba(100, 116, 139, 0.15)",
		text: "rgb(100, 116, 139)",
	},
	failed: {
		dot: SEMANTIC_COLORS.error.from,
		line: SEMANTIC_COLORS.error.from,
		text: SEMANTIC_COLORS.error.text,
	},
};

// ============================================================================
// Stage derivation
// ============================================================================

/**
 * Derives timeline stages from request data.
 *
 * We merge the request status track (Pending → Approved → Completed)
 * with the media status track (Processing → Available) into a single
 * linear flow. Timestamps are only shown where we can confidently
 * attribute them — we never fabricate intermediate timestamps.
 */
function deriveStages(request: SeerrRequest, modifierName?: string): TimelineStage[] {
	const { status, media, createdAt, updatedAt, modifiedBy } = request;
	const hasTimeChanged = createdAt !== updatedAt;

	// Terminal failure paths — short-circuit
	if (status === SEERR_REQUEST_STATUS.DECLINED) {
		return [
			{ label: "Requested", status: "completed", timestamp: createdAt },
			{
				label: "Declined",
				status: "failed",
				timestamp: hasTimeChanged ? updatedAt : undefined,
				actor: modifiedBy ? modifierName : undefined,
			},
		];
	}

	if (status === SEERR_REQUEST_STATUS.FAILED) {
		return [
			{ label: "Requested", status: "completed", timestamp: createdAt },
			{
				label: "Failed",
				status: "failed",
				timestamp: hasTimeChanged ? updatedAt : undefined,
			},
		];
	}

	// Happy path: Requested → Approved → Processing → Available
	const stages: TimelineStage[] = [];

	// Stage 1: Requested — always present
	stages.push({
		label: "Requested",
		status: "completed",
		timestamp: createdAt,
	});

	// Stage 2: Approved
	if (status === SEERR_REQUEST_STATUS.PENDING) {
		stages.push({ label: "Pending", status: "active" });
		stages.push({ label: "Processing", status: "upcoming" });
		stages.push({ label: "Available", status: "upcoming" });
		return stages;
	}

	// Status is Approved (2) or Completed (5) — approval happened
	const approvalStage: TimelineStage = {
		label: "Approved",
		status: "completed",
		actor: modifiedBy ? modifierName : undefined,
	};

	// Only attribute updatedAt to approval if media hasn't progressed further
	// (otherwise updatedAt likely reflects a later media status change)
	if (
		hasTimeChanged &&
		media.status !== SEERR_MEDIA_STATUS.PROCESSING &&
		media.status !== SEERR_MEDIA_STATUS.AVAILABLE &&
		media.status !== SEERR_MEDIA_STATUS.PARTIALLY_AVAILABLE
	) {
		approvalStage.timestamp = updatedAt;
	}
	stages.push(approvalStage);

	// Terminal media states (blocklisted, deleted) — short-circuit
	const isTerminalMedia =
		media.status === SEERR_MEDIA_STATUS.BLOCKLISTED ||
		media.status === SEERR_MEDIA_STATUS.DELETED;

	if (isTerminalMedia) {
		stages.push({ label: "Processing", status: "completed" });
		stages.push({
			label: media.status === SEERR_MEDIA_STATUS.BLOCKLISTED ? "Blocklisted" : "Deleted",
			status: "failed",
		});
		return stages;
	}

	// Stage 3: Processing
	const isProcessing = media.status === SEERR_MEDIA_STATUS.PROCESSING;
	const isMediaPending = media.status === SEERR_MEDIA_STATUS.PENDING;
	const isAvailable =
		media.status === SEERR_MEDIA_STATUS.AVAILABLE ||
		media.status === SEERR_MEDIA_STATUS.PARTIALLY_AVAILABLE;

	// When request is COMPLETED, trust the request status over an ambiguous
	// media state — don't show "upcoming" stages that contradict completion
	const isRequestCompleted = status === SEERR_REQUEST_STATUS.COMPLETED;

	if (isAvailable || isRequestCompleted) {
		stages.push({ label: "Processing", status: "completed" });
	} else if (isProcessing || isMediaPending) {
		stages.push({ label: "Processing", status: "active" });
	} else {
		stages.push({ label: "Processing", status: "upcoming" });
	}

	// Stage 4: Available
	if (isAvailable) {
		stages.push({
			label: media.status === SEERR_MEDIA_STATUS.PARTIALLY_AVAILABLE ? "Partial" : "Available",
			status: "completed",
		});
	} else if (isRequestCompleted) {
		stages.push({ label: "Available", status: "completed" });
	} else {
		stages.push({ label: "Available", status: "upcoming" });
	}

	return stages;
}

// ============================================================================
// Stage icon (compact)
// ============================================================================

function StageIcon({ status, size }: { status: StageStatus; size: number }) {
	const color = STAGE_COLORS[status];
	const iconSize = size - 2;

	if (status === "completed") {
		return <Check className="shrink-0" style={{ color: color.dot, width: iconSize, height: iconSize }} />;
	}
	if (status === "failed") {
		return <X className="shrink-0" style={{ color: color.dot, width: iconSize, height: iconSize }} />;
	}
	if (status === "active") {
		return (
			<span className="relative shrink-0 flex items-center justify-center" style={{ width: size, height: size }}>
				<span
					className="absolute inset-0 rounded-full animate-ping"
					style={{ backgroundColor: color.dot, opacity: 0.3 }}
				/>
				<Circle className="fill-current" style={{ color: color.dot, width: iconSize, height: iconSize }} />
			</span>
		);
	}
	return (
		<Circle className="shrink-0" style={{ color: color.dot, width: iconSize - 2, height: iconSize - 2 }} />
	);
}

// ============================================================================
// Compact variant
// ============================================================================

function CompactTimeline({ stages }: { stages: TimelineStage[] }) {
	return (
		<div className="flex items-center gap-0.5">
			{stages.map((stage, i) => {
				const color = STAGE_COLORS[stage.status];
				const isLast = i === stages.length - 1;
				return (
					<div key={stage.label} className="flex items-center gap-0.5">
						<span
							className="flex items-center gap-0.5"
							title={stage.label + (stage.actor ? ` by ${stage.actor}` : "")}
							aria-label={stage.label + (stage.actor ? ` by ${stage.actor}` : "")}
						>
							<StageIcon status={stage.status} size={10} />
							<span
								className="text-[9px] font-medium leading-none hidden sm:inline"
								style={{ color: color.text }}
								aria-hidden="true"
							>
								{stage.label}
							</span>
						</span>
						{!isLast && (
							<span
								className="mx-0.5 h-[1px] w-2.5 shrink-0"
								style={{
									backgroundColor: STAGE_COLORS[stages[i + 1]?.status ?? "upcoming"].line,
								}}
							/>
						)}
					</div>
				);
			})}
		</div>
	);
}

// ============================================================================
// Expanded variant
// ============================================================================

function ExpandedTimeline({ stages }: { stages: TimelineStage[] }) {
	return (
		<div className="flex items-start gap-0">
			{stages.map((stage, i) => {
				const color = STAGE_COLORS[stage.status];
				const isLast = i === stages.length - 1;
				return (
					<div key={stage.label} className="flex items-start flex-1 min-w-0">
						{/* Stage node */}
						<div className="flex flex-col items-center">
							{/* Dot */}
							<span
								className="flex items-center justify-center rounded-full"
								style={{
									width: 24,
									height: 24,
									backgroundColor: `${color.dot}18`,
									border: `1.5px solid ${color.dot}50`,
								}}
							>
								<StageIcon status={stage.status} size={14} />
							</span>
							{/* Label + metadata below */}
							<span
								className="mt-1.5 text-[11px] font-semibold leading-tight text-center"
								style={{ color: color.text }}
							>
								{stage.label}
							</span>
							{stage.actor && (
								<span className="text-[10px] text-muted-foreground/50 leading-tight text-center mt-0.5">
									by {stage.actor}
								</span>
							)}
							{stage.timestamp && (
								<span className="text-[10px] text-muted-foreground/40 leading-tight text-center mt-0.5 flex items-center gap-0.5">
									<Clock className="h-2.5 w-2.5" />
									{formatRelativeTime(stage.timestamp)}
								</span>
							)}
						</div>
						{/* Connector line */}
						{!isLast && (
							<div className="flex-1 flex items-center pt-[11px] px-1.5 min-w-[16px]">
								<span
									className="h-[1.5px] w-full rounded-full"
									style={{
										backgroundColor: STAGE_COLORS[stages[i + 1]?.status ?? "upcoming"].line,
									}}
								/>
							</div>
						)}
					</div>
				);
			})}
		</div>
	);
}

// ============================================================================
// Public component
// ============================================================================

export const RequestStatusTimeline = ({
	request,
	variant,
	modifierName,
}: RequestStatusTimelineProps) => {
	const stages = deriveStages(request, modifierName);

	if (variant === "compact") {
		return <CompactTimeline stages={stages} />;
	}
	return <ExpandedTimeline stages={stages} />;
};
