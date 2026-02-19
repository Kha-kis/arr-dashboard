"use client";

import type { ReactNode } from "react";
import type { SeerrRequest } from "@arr/shared";
import { Film, Tv } from "lucide-react";
import { GlassmorphicCard, StatusBadge } from "../../../components/layout";
import { getRequestStatusLabel, getRequestStatusVariant, formatRelativeTime, getPosterUrl } from "../lib/seerr-utils";

interface RequestCardProps {
	request: SeerrRequest;
	actions?: ReactNode;
	index?: number;
}

export const RequestCard = ({ request, actions, index = 0 }: RequestCardProps) => {
	const posterUrl = getPosterUrl(request.mediaInfo?.posterPath);
	const TypeIcon = request.type === "movie" ? Film : Tv;

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
								alt={request.mediaInfo?.title ?? "Media"}
								className="h-full w-full object-cover"
							/>
						) : (
							<TypeIcon className="h-5 w-5 text-muted-foreground" />
						)}
					</div>

					{/* Title + metadata */}
					<div className="min-w-0 flex-1">
						<div className="flex items-center gap-2">
							<h3 className="truncate text-sm font-semibold text-foreground">
								{request.mediaInfo?.title ?? `${request.type === "movie" ? "Movie" : "Series"} #${request.media.tmdbId}`}
							</h3>
							<StatusBadge status={getRequestStatusVariant(request.status)}>
								{getRequestStatusLabel(request.status)}
							</StatusBadge>
						</div>
						<div className="mt-1 flex items-center gap-3 text-xs text-muted-foreground">
							<span className="flex items-center gap-1">
								<TypeIcon className="h-3 w-3" />
								{request.type === "movie" ? "Movie" : "TV"}
								{request.is4k && " (4K)"}
							</span>
							<span>by {request.requestedBy.displayName}</span>
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
