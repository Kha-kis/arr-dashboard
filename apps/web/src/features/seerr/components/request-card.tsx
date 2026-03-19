"use client";

import type { SeerrMediaStatus, SeerrRequest, SeerrSeason } from "@arr/shared";
import { SEERR_MEDIA_STATUS, SEERR_REQUEST_STATUS } from "@arr/shared";
import { Calendar, Film, Tv, User } from "lucide-react";
import Image from "next/image";
import type { ReactNode } from "react";
import { StatusBadge } from "../../../components/layout";
import { SEMANTIC_COLORS, SERVICE_GRADIENTS } from "../../../lib/theme-gradients";
import {
	formatRelativeTime,
	getMediaStatusLabel,
	getMediaStatusVariant,
	getPosterUrl,
	getRequestStatusLabel,
	getRequestStatusVariant,
} from "../lib/seerr-utils";

// ============================================================================
// Types
// ============================================================================

interface RequestCardProps {
	request: SeerrRequest;
	actions?: ReactNode;
	index?: number;
	onClick?: () => void;
}

// ============================================================================
// Status-to-color mapping
// ============================================================================

const SEERR_GRADIENT = SERVICE_GRADIENTS.seerr;

function getStatusAccentColor(status: number): { from: string; to: string; glow: string } {
	switch (status) {
		case SEERR_REQUEST_STATUS.PENDING:
			return { from: SEMANTIC_COLORS.warning.from, to: SEMANTIC_COLORS.warning.to, glow: SEMANTIC_COLORS.warning.glow };
		case SEERR_REQUEST_STATUS.APPROVED:
		case SEERR_REQUEST_STATUS.COMPLETED:
			return { from: SEMANTIC_COLORS.success.from, to: SEMANTIC_COLORS.success.to, glow: SEMANTIC_COLORS.success.glow };
		case SEERR_REQUEST_STATUS.DECLINED:
		case SEERR_REQUEST_STATUS.FAILED:
			return { from: SEMANTIC_COLORS.error.from, to: SEMANTIC_COLORS.error.to, glow: SEMANTIC_COLORS.error.glow };
		default:
			return { from: SEERR_GRADIENT.from, to: SEERR_GRADIENT.to, glow: SEERR_GRADIENT.glow };
	}
}

// ============================================================================
// Season helpers
// ============================================================================

function getSeasonStatusColor(status: SeerrMediaStatus): string {
	switch (status) {
		case SEERR_MEDIA_STATUS.AVAILABLE:
			return "bg-emerald-400";
		case SEERR_MEDIA_STATUS.PARTIALLY_AVAILABLE:
			return "bg-sky-400";
		case SEERR_MEDIA_STATUS.PROCESSING:
			return "bg-amber-400";
		case SEERR_MEDIA_STATUS.PENDING:
			return "bg-amber-400/60";
		default:
			return "bg-muted-foreground/40";
	}
}

const SEERR_MEDIA_STATUS_LABEL_MAP: Record<number, string> = {
	1: "Unavailable",
	2: "Pending",
	3: "Processing",
	4: "Partially Available",
	5: "Available",
	6: "Blocklisted",
	7: "Deleted",
};

function formatSeasons(seasons?: SeerrSeason[]): ReactNode | null {
	if (!seasons || seasons.length === 0) return null;
	if (seasons.length <= 5) {
		return (
			<span className="flex items-center gap-1.5">
				{seasons.map((s) => (
					<span key={s.seasonNumber} className="flex items-center gap-0.5">
						<span
							className={`inline-block h-1.5 w-1.5 rounded-full ${getSeasonStatusColor(s.status)}`}
							title={`S${s.seasonNumber}: ${SEERR_MEDIA_STATUS_LABEL_MAP[s.status] ?? "Unknown"}`}
						/>
						S{s.seasonNumber}
					</span>
				))}
			</span>
		);
	}
	const availableCount = seasons.filter((s) => s.status === SEERR_MEDIA_STATUS.AVAILABLE).length;
	if (availableCount > 0 && availableCount < seasons.length) {
		return `${seasons.length} seasons (${availableCount} available)`;
	}
	return `${seasons.length} seasons`;
}

// ============================================================================
// Metadata chip
// ============================================================================

const MetaChip = ({
	icon: Icon,
	children,
}: {
	icon?: React.ComponentType<{ className?: string }>;
	children: React.ReactNode;
}) => (
	<span className="inline-flex items-center gap-1 text-[11px] text-muted-foreground/50">
		{Icon && <Icon className="h-3 w-3 shrink-0" />}
		{children}
	</span>
);

// ============================================================================
// Component
// ============================================================================

export const RequestCard = ({ request, actions, index = 0, onClick }: RequestCardProps) => {
	const posterUrl = getPosterUrl(request.media.posterPath);
	const TypeIcon = request.type === "movie" ? Film : Tv;
	const seasonInfo = request.type === "tv" ? formatSeasons(request.seasons) : null;
	const statusAccent = getStatusAccentColor(request.status);
	const showMediaStatus =
		request.status === SEERR_REQUEST_STATUS.APPROVED ||
		request.status === SEERR_REQUEST_STATUS.COMPLETED ||
		request.status === SEERR_REQUEST_STATUS.FAILED;

	return (
		<div
			className={`group relative rounded-xl overflow-hidden transition-all duration-200 hover:-translate-y-[1px] hover:shadow-lg hover:shadow-black/10 animate-in fade-in slide-in-from-bottom-1 duration-300${onClick ? " cursor-pointer" : ""}`}
			style={{
				border: `1px solid ${statusAccent.from}10`,
				animationDelay: `${index * 50}ms`,
				animationFillMode: "backwards",
			}}
			onClick={onClick}
			onKeyDown={
				onClick
					? (e) => {
							if (e.key === "Enter" || e.key === " ") {
								e.preventDefault();
								onClick();
							}
						}
					: undefined
			}
			role={onClick ? "button" : undefined}
			tabIndex={onClick ? 0 : undefined}
		>
			{/* Status-tinted background with diagonal gradient */}
			<div
				className="absolute inset-0 pointer-events-none"
				style={{
					background: `linear-gradient(135deg, ${statusAccent.from}06, transparent 60%)`,
				}}
			/>

			{/* Hover glow effect */}
			<div
				className="absolute inset-0 pointer-events-none opacity-0 group-hover:opacity-100 transition-opacity duration-200"
				style={{
					background: `radial-gradient(ellipse at top left, ${statusAccent.from}08, transparent 50%)`,
				}}
			/>

			<div className="relative flex">
				{/* Status accent bar */}
				<div
					className="absolute left-0 top-0 bottom-0 w-[3px]"
					style={{
						background: `linear-gradient(180deg, ${statusAccent.from}, ${statusAccent.to}70)`,
					}}
				/>

				{/* Content area */}
				<div className="flex-1 min-w-0 flex items-start gap-4 py-3.5 pl-5 pr-4">
					{/* Poster thumbnail */}
					<div
						className="shrink-0 w-[44px] h-[64px] rounded-md overflow-hidden ring-1 ring-white/[0.06] flex items-center justify-center"
						style={{
							boxShadow: posterUrl
								? `0 2px 8px ${SEERR_GRADIENT.from}10, 0 4px 12px rgba(0,0,0,0.2)`
								: undefined,
							backgroundColor: posterUrl ? undefined : "rgba(255,255,255,0.04)",
						}}
					>
						{posterUrl ? (
							<Image
								src={posterUrl}
								alt={request.media.title ?? "Media"}
								width={44}
								height={64}
								className="h-full w-full object-cover"
							/>
						) : (
							<TypeIcon className="h-5 w-5 text-muted-foreground/40" />
						)}
					</div>

					{/* Title + metadata */}
					<div className="min-w-0 flex-1">
						{/* Top row: type pill + requester */}
						<div className="flex items-center gap-2 mb-1.5">
							{/* Type pill with seerr brand color */}
							<span
								className="inline-flex items-center gap-1 rounded-md px-1.5 py-0.5 text-[10px] font-semibold uppercase tracking-wider shrink-0"
								style={{
									backgroundColor: `${SEERR_GRADIENT.from}12`,
									color: SEERR_GRADIENT.from,
									boxShadow: `0 0 10px ${SEERR_GRADIENT.from}08`,
								}}
							>
								<TypeIcon className="h-2.5 w-2.5" />
								{request.type === "movie" ? "Movie" : "TV"}
								{request.is4k && " · 4K"}
							</span>

							{/* Requester */}
							<MetaChip icon={User}>{request.requestedBy.displayName}</MetaChip>

							{/* Separator dot */}
							<span
								className="h-[3px] w-[3px] rounded-full shrink-0"
								style={{ backgroundColor: `${statusAccent.from}30` }}
							/>

							{/* Time */}
							<MetaChip icon={Calendar}>{formatRelativeTime(request.createdAt)}</MetaChip>
						</div>

						{/* Title row */}
						<h3 className="text-[14px] font-semibold text-foreground leading-snug flex items-center gap-2 flex-wrap">
							<span className="truncate">
								{request.media.title ??
									`${request.type === "movie" ? "Movie" : "Series"} #${request.media.tmdbId}`}
							</span>
							<StatusBadge status={getRequestStatusVariant(request.status)}>
								{getRequestStatusLabel(request.status)}
							</StatusBadge>
							{showMediaStatus && (
								<StatusBadge status={getMediaStatusVariant(request.media.status)}>
									{getMediaStatusLabel(request.media.status)}
								</StatusBadge>
							)}
						</h3>

						{/* Metadata row */}
						<div className="flex flex-wrap items-center gap-x-3 gap-y-1 mt-1.5">
							{seasonInfo && (
								<span className="inline-flex items-center text-[11px] text-muted-foreground/50">
									{seasonInfo}
								</span>
							)}
							{request.media.overview && (
								<p className="w-full mt-1 text-[11.5px] leading-relaxed text-muted-foreground/40 line-clamp-1">
									{request.media.overview}
								</p>
							)}
							{request.modifiedBy && (
								<span className="text-[11px] text-muted-foreground/35">
									{request.status === SEERR_REQUEST_STATUS.APPROVED ||
									request.status === SEERR_REQUEST_STATUS.COMPLETED
										? "Approved"
										: request.status === SEERR_REQUEST_STATUS.DECLINED
											? "Declined"
											: "Modified"}{" "}
									by {request.modifiedBy.displayName}
								</span>
							)}
						</div>
					</div>

					{/* Action buttons */}
					{actions && (
						<div
							className="flex shrink-0 items-center gap-2 pt-1"
							onClick={(e) => e.stopPropagation()}
							onKeyDown={(e) => e.stopPropagation()}
						>
							{actions}
						</div>
					)}
				</div>
			</div>
		</div>
	);
};
