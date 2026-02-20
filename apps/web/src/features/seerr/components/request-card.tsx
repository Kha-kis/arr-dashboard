"use client";

import type { ReactNode } from "react";
import Image from "next/image";
import type { SeerrRequest, SeerrSeason, SeerrMediaStatus } from "@arr/shared";
import { SEERR_REQUEST_STATUS, SEERR_MEDIA_STATUS } from "@arr/shared";
import { Film, Tv, User } from "lucide-react";
import { GlassmorphicCard, StatusBadge } from "../../../components/layout";
import {
	getRequestStatusLabel,
	getRequestStatusVariant,
	getMediaStatusLabel,
	getMediaStatusVariant,
	formatRelativeTime,
	getPosterUrl,
} from "../lib/seerr-utils";

interface RequestCardProps {
	request: SeerrRequest;
	actions?: ReactNode;
	index?: number;
	onClick?: () => void;
}

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
	const availableCount = seasons.filter(
		(s) => s.status === SEERR_MEDIA_STATUS.AVAILABLE,
	).length;
	if (availableCount > 0 && availableCount < seasons.length) {
		return `${seasons.length} seasons (${availableCount} available)`;
	}
	return `${seasons.length} seasons`;
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

export const RequestCard = ({ request, actions, index = 0, onClick }: RequestCardProps) => {
	const posterUrl = getPosterUrl(request.media.posterPath);
	const TypeIcon = request.type === "movie" ? Film : Tv;
	const seasonInfo = request.type === "tv" ? formatSeasons(request.seasons) : null;
	const showMediaStatus =
		request.status === SEERR_REQUEST_STATUS.APPROVED ||
		request.status === SEERR_REQUEST_STATUS.COMPLETED ||
		request.status === SEERR_REQUEST_STATUS.FAILED;

	return (
		<div
			className={`animate-in fade-in slide-in-from-bottom-2 duration-300${onClick ? " cursor-pointer" : ""}`}
			style={{ animationDelay: `${index * 30}ms`, animationFillMode: "backwards" }}
			onClick={onClick}
			onKeyDown={onClick ? (e) => { if (e.key === "Enter" || e.key === " ") { e.preventDefault(); onClick(); } } : undefined}
			role={onClick ? "button" : undefined}
			tabIndex={onClick ? 0 : undefined}
		>
			<GlassmorphicCard padding="none">
				<div className="flex items-center gap-4 p-4">
					{/* Poster thumbnail */}
					<div className="flex h-16 w-11 shrink-0 items-center justify-center overflow-hidden rounded-md bg-muted/30">
						{posterUrl ? (
							<Image
								src={posterUrl}
								alt={request.media.title ?? "Media"}
								width={44}
								height={64}
								className="h-full w-full object-cover"
							/>
						) : (
							<TypeIcon className="h-5 w-5 text-muted-foreground" />
						)}
					</div>

					{/* Title + metadata */}
					<div className="min-w-0 flex-1">
						<div className="flex items-center gap-2 flex-wrap">
							<h3 className="truncate text-sm font-semibold text-foreground">
								{request.media.title ?? `${request.type === "movie" ? "Movie" : "Series"} #${request.media.tmdbId}`}
							</h3>
							<StatusBadge status={getRequestStatusVariant(request.status)}>
								{getRequestStatusLabel(request.status)}
							</StatusBadge>
							{showMediaStatus && (
								<StatusBadge status={getMediaStatusVariant(request.media.status)}>
									{getMediaStatusLabel(request.media.status)}
								</StatusBadge>
							)}
						</div>
						<div className="mt-1 flex items-center gap-3 text-xs text-muted-foreground flex-wrap">
							<span className="flex items-center gap-1">
								<TypeIcon className="h-3 w-3" />
								{request.type === "movie" ? "Movie" : "TV"}
								{request.is4k && " (4K)"}
							</span>
							{seasonInfo && <span className="flex items-center">{seasonInfo}</span>}
							<span className="flex items-center gap-1">
								<User className="h-3 w-3" />
								{request.requestedBy.displayName}
							</span>
							<span>{formatRelativeTime(request.createdAt)}</span>
							{request.modifiedBy && (
								<span className="text-muted-foreground/70">
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
					{actions && <div className="flex shrink-0 items-center gap-2" onClick={(e) => e.stopPropagation()} onKeyDown={(e) => e.stopPropagation()}>{actions}</div>}
				</div>
			</GlassmorphicCard>
		</div>
	);
};
