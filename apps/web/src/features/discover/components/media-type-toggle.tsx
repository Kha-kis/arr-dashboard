"use client";

import type { DiscoverSearchType } from "@arr/shared";
import { Film, Tv } from "lucide-react";
import { Button } from "../../../components/ui";

/**
 * Props for the MediaTypeToggle component
 */
interface MediaTypeToggleProps {
	/** The currently selected media type */
	searchType: DiscoverSearchType;
	/** Callback when media type changes */
	onTypeChange: (type: DiscoverSearchType) => void;
	/** Number of connected instances */
	instanceCount: number;
}

/**
 * Returns the appropriate icon for a media type.
 */
const iconForType = (type: DiscoverSearchType) =>
	type === "movie" ? <Film className="h-4 w-4" /> : <Tv className="h-4 w-4" />;

/**
 * Toggle component for switching between movie and series search modes.
 * Displays the number of connected instances for the current media type.
 *
 * @component
 * @example
 * <MediaTypeToggle
 *   searchType="movie"
 *   onTypeChange={setSearchType}
 *   instanceCount={3}
 * />
 */
export const MediaTypeToggle: React.FC<MediaTypeToggleProps> = ({
	searchType,
	onTypeChange,
	instanceCount,
}) => {
	return (
		<div className="flex flex-wrap items-center gap-3">
			<div className="inline-flex rounded-full bg-white/10 p-1">
				{(["movie", "series"] as DiscoverSearchType[]).map((type) => (
					<Button
						key={type}
						variant={searchType === type ? "primary" : "secondary"}
						className="flex items-center gap-2 px-4 py-2 text-sm"
						onClick={() => onTypeChange(type)}
						type="button"
					>
						{iconForType(type)}
						<span>{type === "movie" ? "Movies" : "Series"}</span>
					</Button>
				))}
			</div>
			<span className="text-sm text-white/50">
				{instanceCount} {searchType === "movie" ? "Radarr" : "Sonarr"} instance
				{instanceCount === 1 ? "" : "s"} connected
			</span>
		</div>
	);
};
