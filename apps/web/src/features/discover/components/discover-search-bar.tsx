"use client";

import { Search, X } from "lucide-react";
import { useThemeGradient } from "../../../hooks/useThemeGradient";

interface DiscoverSearchBarProps {
	value: string;
	onChange: (value: string) => void;
	onClear: () => void;
	placeholder?: string;
}

export const DiscoverSearchBar: React.FC<DiscoverSearchBarProps> = ({
	value,
	onChange,
	onClear,
	placeholder = "Search movies & TV shows...",
}) => {
	const { gradient: themeGradient } = useThemeGradient();

	return (
		<div className="relative group">
			<div
				className="absolute -inset-px rounded-xl opacity-0 group-focus-within:opacity-100 transition-opacity duration-300"
				style={{
					background: `linear-gradient(135deg, ${themeGradient.from}40, ${themeGradient.to}40)`,
				}}
			/>
			<div className="relative flex items-center rounded-xl border border-border/50 bg-card/60 backdrop-blur-sm transition-colors group-focus-within:border-transparent">
				<Search className="ml-4 h-5 w-5 shrink-0 text-muted-foreground" />
				<input
					type="text"
					value={value}
					onChange={(e) => onChange(e.target.value)}
					placeholder={placeholder}
					className="flex-1 bg-transparent px-3 py-3 text-sm text-foreground placeholder:text-muted-foreground focus:outline-none"
				/>
				{value.length > 0 && (
					<button
						type="button"
						onClick={onClear}
						className="mr-3 rounded-md p-1 text-muted-foreground transition-colors hover:text-foreground"
						aria-label="Clear search"
					>
						<X className="h-4 w-4" />
					</button>
				)}
			</div>
		</div>
	);
};
