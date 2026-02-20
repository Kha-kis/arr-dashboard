"use client";

import { Search, Loader2 } from "lucide-react";
import type { SeerrDiscoverResult, SeerrDiscoverResponse } from "@arr/shared";
import { useThemeGradient } from "../../../hooks/useThemeGradient";
import { PremiumSkeleton } from "../../../components/layout";
import { DiscoverPosterCard } from "./discover-poster-card";

interface DiscoverSearchResultsProps {
	data: SeerrDiscoverResponse | undefined;
	isLoading: boolean;
	onSelectItem: (item: SeerrDiscoverResult) => void;
	query: string;
}

export const DiscoverSearchResults: React.FC<DiscoverSearchResultsProps> = ({
	data,
	isLoading,
	onSelectItem,
	query,
}) => {
	const { gradient: themeGradient } = useThemeGradient();

	if (isLoading) {
		return (
			<div className="space-y-4 animate-in fade-in duration-300">
				<div className="flex items-center gap-2 text-sm text-muted-foreground">
					<Loader2 className="h-4 w-4 animate-spin" style={{ color: themeGradient.from }} />
					Searching for &quot;{query}&quot;...
				</div>
				<div className="grid grid-cols-2 sm:grid-cols-3 md:grid-cols-4 lg:grid-cols-5 xl:grid-cols-6 gap-4">
					{Array.from({ length: 12 }).map((_, i) => (
						<div key={i} className="rounded-xl border border-border/30 bg-card/30 overflow-hidden">
							<PremiumSkeleton
								variant="card"
								className="aspect-2/3 rounded-none"
								style={{ animationDelay: `${i * 30}ms` }}
							/>
							<div className="p-3 space-y-2">
								<PremiumSkeleton variant="line" className="h-4 w-3/4" />
								<PremiumSkeleton variant="line" className="h-3 w-1/2" />
							</div>
						</div>
					))}
				</div>
			</div>
		);
	}

	if (!data || data.results.length === 0) {
		return (
			<div className="flex flex-col items-center justify-center py-16 text-center space-y-4 animate-in fade-in duration-300">
				<div
					className="flex h-14 w-14 items-center justify-center rounded-xl"
					style={{
						background: `linear-gradient(135deg, ${themeGradient.from}15, ${themeGradient.to}15)`,
						border: `1px solid ${themeGradient.from}20`,
					}}
				>
					<Search className="h-6 w-6 text-muted-foreground" />
				</div>
				<div className="space-y-1">
					<p className="text-sm font-medium text-foreground">No results found</p>
					<p className="text-xs text-muted-foreground">
						Try a different search term or browse the categories below
					</p>
				</div>
			</div>
		);
	}

	return (
		<div className="space-y-4 animate-in fade-in duration-300">
			<div className="flex items-center gap-2 text-sm text-muted-foreground">
				<Search className="h-4 w-4" />
				<span>
					Found <span className="font-medium text-foreground">{data.totalResults}</span> results
					for &quot;{query}&quot;
				</span>
			</div>

			<div className="grid grid-cols-2 sm:grid-cols-3 md:grid-cols-4 lg:grid-cols-5 xl:grid-cols-6 gap-4">
				{data.results.map((item, index) => (
					<DiscoverPosterCard
						key={`${item.id}-${item.mediaType}`}
						item={item}
						onClick={onSelectItem}
						index={index}
					/>
				))}
			</div>
		</div>
	);
};
