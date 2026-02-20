"use client";

import { Star } from "lucide-react";
import type { SeerrDiscoverResult } from "@arr/shared";
import { RATING_COLOR } from "../../../lib/theme-gradients";
import { useThemeGradient } from "../../../hooks/useThemeGradient";
import {
	getSeerrImageUrl,
	getMediaStatusInfo,
	getDisplayTitle,
	getReleaseYear,
	isLikelyAnime,
} from "../lib/seerr-image-utils";

interface DiscoverPosterCardProps {
	item: SeerrDiscoverResult;
	onClick: (item: SeerrDiscoverResult) => void;
	index: number;
}

export const DiscoverPosterCard: React.FC<DiscoverPosterCardProps> = ({
	item,
	onClick,
	index,
}) => {
	const { gradient: themeGradient } = useThemeGradient();
	const posterUrl = getSeerrImageUrl(item.posterPath, "w300");
	const title = getDisplayTitle(item);
	const year = getReleaseYear(item);
	const statusInfo = getMediaStatusInfo(item.mediaInfo?.status);
	const anime = isLikelyAnime(item);

	return (
		<div
			className="group relative w-[160px] shrink-0 cursor-pointer overflow-hidden rounded-xl transition-all duration-300 hover:scale-[1.03] animate-in fade-in slide-in-from-bottom-2"
			style={{
				animationDelay: `${index * 30}ms`,
				animationFillMode: "backwards",
			}}
			onClick={() => onClick(item)}
		>
			{/* Gradient border on hover */}
			<div
				className="absolute inset-0 rounded-xl transition-opacity duration-300 opacity-0 group-hover:opacity-100"
				style={{
					background: `linear-gradient(135deg, ${themeGradient.from}40, ${themeGradient.to}40)`,
					padding: "1px",
				}}
			/>

			<div className="relative rounded-xl border border-border/50 bg-card/80 backdrop-blur-xs overflow-hidden group-hover:border-transparent transition-colors duration-300">
				{/* Poster */}
				<div className="relative aspect-2/3 w-full overflow-hidden bg-linear-to-br from-slate-800 to-slate-900">
					{posterUrl ? (
						/* eslint-disable-next-line @next/next/no-img-element */
						<img
							src={posterUrl}
							alt={title}
							className="h-full w-full object-cover transition-transform duration-500 group-hover:scale-110"
							loading="lazy"
						/>
					) : (
						<div className="flex h-full items-center justify-center text-xs text-muted-foreground">
							No poster
						</div>
					)}

					{/* Gradient overlay on hover */}
					<div
						className="absolute inset-0 opacity-0 group-hover:opacity-100 transition-opacity duration-300"
						style={{
							background: `linear-gradient(to top, ${themeGradient.from}40, transparent 60%)`,
						}}
					/>

					{/* Status badge (top-left) */}
					{statusInfo && (
						<div
							className="absolute left-2 top-2 rounded-md px-2 py-0.5 text-[10px] font-semibold uppercase tracking-wider backdrop-blur-md"
							style={{
								backgroundColor: statusInfo.bg,
								border: `1px solid ${statusInfo.border}`,
								color: statusInfo.text,
							}}
						>
							{statusInfo.label}
						</div>
					)}

					{/* Rating badge (top-right) */}
					{typeof item.voteAverage === "number" && item.voteAverage > 0 && (
						<div
							className="absolute right-2 top-2 flex items-center gap-1 rounded-lg px-2 py-1 text-xs font-medium backdrop-blur-md"
							style={{
								backgroundColor: "rgba(245, 158, 11, 0.1)",
								border: "1px solid rgba(245, 158, 11, 0.3)",
								color: RATING_COLOR,
							}}
						>
							<Star className="h-3 w-3 fill-yellow-400" />
							{item.voteAverage.toFixed(1)}
						</div>
					)}
				</div>

				{/* Title section */}
				<div className="p-3 space-y-1">
					<p className="truncate text-sm font-medium text-foreground group-hover:text-foreground transition-colors">
						{title}
					</p>
					<div className="flex items-center gap-1.5">
						{year && <span className="text-xs text-muted-foreground">{year}</span>}
						{anime && (
							<span className="rounded px-1.5 py-0.5 text-[10px] font-semibold uppercase tracking-wider text-pink-400 bg-pink-500/10 border border-pink-500/20">
								Anime
							</span>
						)}
					</div>
				</div>
			</div>
		</div>
	);
};
