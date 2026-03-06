"use client";

import { useThemeGradient } from "../../../hooks/useThemeGradient";
import { useUserEpisodeCompletion } from "../../../hooks/api/usePlex";
import { PremiumEmptyState, PremiumSkeleton } from "../../../components/layout";
import { Grid3X3 } from "lucide-react";

// ============================================================================
// Completion Bar
// ============================================================================

const CompletionBar = ({ username, watched, total, percent, color }: {
	username: string;
	watched: number;
	total: number;
	percent: number;
	color: string;
}) => (
	<div className="flex items-center gap-3 text-xs">
		<div
			className="h-6 w-6 rounded-full flex items-center justify-center text-[10px] font-bold shrink-0"
			style={{ backgroundColor: `${color}20`, color }}
		>
			{username.charAt(0).toUpperCase()}
		</div>
		<span className="w-20 truncate text-muted-foreground" title={username}>
			{username}
		</span>
		<div className="flex-1 h-4 rounded-full bg-muted/30 overflow-hidden">
			<div
				className="h-full rounded-full transition-all duration-500"
				style={{
					width: `${percent}%`,
					background: `linear-gradient(90deg, ${color}, ${color}bb)`,
				}}
			/>
		</div>
		<span className="w-16 text-right font-medium tabular-nums text-muted-foreground">
			{watched}/{total}
		</span>
		<span className="w-10 text-right font-medium tabular-nums">
			{percent}%
		</span>
	</div>
);

// ============================================================================
// User Episode Matrix
// ============================================================================

interface UserEpisodeMatrixProps {
	tmdbIds: number[];
	enabled: boolean;
}

export const UserEpisodeMatrix = ({ tmdbIds, enabled }: UserEpisodeMatrixProps) => {
	const { gradient } = useThemeGradient();
	const { data, isLoading, isError } = useUserEpisodeCompletion(tmdbIds, enabled);

	if (isLoading) {
		return (
			<div className="rounded-xl border border-border/30 bg-card/30 backdrop-blur-xs p-6">
				<PremiumSkeleton variant="line" className="h-5 w-40 mb-4" />
				<PremiumSkeleton variant="line" className="h-[80px] w-full" />
			</div>
		);
	}

	if (isError) {
		return (
			<PremiumEmptyState
				icon={Grid3X3}
				title="Failed to Load Episode Data"
				description="Could not fetch episode completion data."
			/>
		);
	}

	if (!data || data.shows.length === 0) {
		return null; // Don't show empty state — this widget is contextual
	}

	return (
		<div className="rounded-xl border border-border/30 bg-card/30 backdrop-blur-xs p-6 space-y-4">
			<h3 className="text-sm font-medium text-muted-foreground flex items-center gap-2">
				<Grid3X3 className="h-4 w-4" style={{ color: gradient.from }} />
				Episode Completion by User
			</h3>

			{data.shows.map((show: { tmdbId: number; users: Array<{ username: string; watched: number; total: number; percent: number }> }) => (
				<div key={show.tmdbId} className="space-y-2">
					{show.users.length > 0 ? (
						show.users.map((user: { username: string; watched: number; total: number; percent: number }) => (
							<CompletionBar
								key={user.username}
								{...user}
								color={gradient.from}
							/>
						))
					) : (
						<p className="text-xs text-muted-foreground italic">No watch data for this show</p>
					)}
				</div>
			))}
		</div>
	);
};
