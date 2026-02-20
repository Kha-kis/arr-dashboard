"use client";

import { Film, Tv } from "lucide-react";
import { useThemeGradient } from "../../../hooks/useThemeGradient";
import type { DiscoverMediaType } from "../hooks/use-discover-state";

interface DiscoverMediaToggleProps {
	value: DiscoverMediaType;
	onChange: (type: DiscoverMediaType) => void;
}

export const DiscoverMediaToggle: React.FC<DiscoverMediaToggleProps> = ({ value, onChange }) => {
	const { gradient: themeGradient } = useThemeGradient();

	const options: { type: DiscoverMediaType; label: string; icon: typeof Film }[] = [
		{ type: "movie", label: "Movies", icon: Film },
		{ type: "tv", label: "TV Shows", icon: Tv },
	];

	return (
		<div className="inline-flex rounded-xl border border-border/50 bg-card/40 p-1 backdrop-blur-sm">
			{options.map(({ type, label, icon: Icon }) => {
				const isActive = value === type;
				return (
					<button
						key={type}
						type="button"
						onClick={() => onChange(type)}
						className="relative flex items-center gap-2 rounded-lg px-4 py-2 text-sm font-medium transition-all duration-200"
						style={
							isActive
								? {
										background: `linear-gradient(135deg, ${themeGradient.from}20, ${themeGradient.to}20)`,
										border: `1px solid ${themeGradient.from}30`,
										color: themeGradient.from,
									}
								: {
										color: "var(--muted-foreground)",
										border: "1px solid transparent",
									}
						}
					>
						<Icon className="h-4 w-4" />
						{label}
					</button>
				);
			})}
		</div>
	);
};
