"use client";

import { Compass, ExternalLink } from "lucide-react";
import { useThemeGradient } from "../../../hooks/useThemeGradient";
import { GlassmorphicCard } from "../../../components/layout";

export const DiscoverEmptyState: React.FC = () => {
	const { gradient: themeGradient } = useThemeGradient();

	return (
		<GlassmorphicCard padding="lg" className="animate-in fade-in slide-in-from-bottom-4 duration-500">
			<div className="flex flex-col items-center justify-center py-12 text-center space-y-6">
				<div
					className="flex h-16 w-16 items-center justify-center rounded-2xl"
					style={{
						background: `linear-gradient(135deg, ${themeGradient.from}20, ${themeGradient.to}20)`,
						border: `1px solid ${themeGradient.from}30`,
					}}
				>
					<Compass className="h-8 w-8" style={{ color: themeGradient.from }} />
				</div>

				<div className="space-y-2 max-w-md">
					<h2 className="text-xl font-semibold text-foreground">
						Connect Seerr to Discover Content
					</h2>
					<p className="text-sm text-muted-foreground leading-relaxed">
						Add a Jellyseerr or Overseerr instance in your settings to browse trending
						movies and TV shows, see what&apos;s available in your library, and submit
						requests.
					</p>
				</div>

				<a
					href="/settings"
					className="inline-flex items-center gap-2 rounded-xl px-5 py-2.5 text-sm font-medium text-white transition-all duration-200 hover:scale-105"
					style={{
						background: `linear-gradient(135deg, ${themeGradient.from}, ${themeGradient.to})`,
						boxShadow: `0 4px 16px -4px ${themeGradient.glow}`,
					}}
				>
					Go to Settings
					<ExternalLink className="h-4 w-4" />
				</a>
			</div>
		</GlassmorphicCard>
	);
};
