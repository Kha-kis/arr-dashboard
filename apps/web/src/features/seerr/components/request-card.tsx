"use client";

import type { ReactNode } from "react";
import type { SeerrRequest } from "@arr/shared";
import { SEERR_REQUEST_STATUS } from "@arr/shared";
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
}

function formatSeasons(seasons?: { seasonNumber: number }[]): string | null {
	if (!seasons || seasons.length === 0) return null;
	if (seasons.length <= 4) {
		return seasons.map((s) => `S${s.seasonNumber}`).join(", ");
	}
	return `${seasons.length} seasons`;
}

export const RequestCard = ({ request, actions, index = 0 }: RequestCardProps) => {
	const posterUrl = getPosterUrl(request.media.posterPath);
	const TypeIcon = request.type === "movie" ? Film : Tv;
	const seasonInfo = request.type === "tv" ? formatSeasons(request.seasons) : null;
	const showMediaStatus =
		request.status === SEERR_REQUEST_STATUS.APPROVED ||
		request.status === SEERR_REQUEST_STATUS.COMPLETED ||
		request.status === SEERR_REQUEST_STATUS.FAILED;

	return (
		<div
			className="animate-in fade-in slide-in-from-bottom-2 duration-300"
			style={{ animationDelay: `${index * 30}ms`, animationFillMode: "backwards" }}
		>
			<GlassmorphicCard padding="none">
				<div className="flex items-center gap-4 p-4">
					{/* Poster thumbnail */}
					<div className="flex h-16 w-11 shrink-0 items-center justify-center overflow-hidden rounded-md bg-muted/30">
						{posterUrl ? (
							<img
								src={posterUrl}
								alt={request.media.title ?? "Media"}
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
							{seasonInfo && <span>{seasonInfo}</span>}
							<span className="flex items-center gap-1">
								<User className="h-3 w-3" />
								{request.requestedBy.displayName}
							</span>
							<span>{formatRelativeTime(request.createdAt)}</span>
						</div>
					</div>

					{/* Action buttons */}
					{actions && <div className="flex shrink-0 items-center gap-2">{actions}</div>}
				</div>
			</GlassmorphicCard>
		</div>
	);
};
