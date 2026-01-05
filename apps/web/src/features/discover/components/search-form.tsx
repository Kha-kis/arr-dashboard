"use client";

import type { DiscoverSearchType } from "@arr/shared";
import { Loader2, Search, AlertTriangle } from "lucide-react";
import { Button } from "../../../components/ui/button";
import { Input } from "../../../components/ui/input";
import { THEME_GRADIENTS, SEMANTIC_COLORS } from "../../../lib/theme-gradients";
import { useColorTheme } from "../../../providers/color-theme-provider";

/**
 * Props for the SearchForm component
 */
interface SearchFormProps {
	/** The current search input value */
	searchInput: string;
	/** Callback when search input changes */
	onSearchInputChange: (value: string) => void;
	/** Callback when form is submitted */
	onSubmit: (event: React.FormEvent<HTMLFormElement>) => void;
	/** The current media type being searched */
	searchType: DiscoverSearchType;
	/** Whether the search is currently loading */
	isLoading: boolean;
	/** Whether search is available (instances configured) */
	canSearch: boolean;
}

/**
 * Premium Search Form
 *
 * Search form component for discovering movies and series with:
 * - Theme-aware search input with focus styling
 * - Gradient submit button
 * - Warning message for missing instances
 * - Loading state with spinner
 */
export const SearchForm: React.FC<SearchFormProps> = ({
	searchInput,
	onSearchInputChange,
	onSubmit,
	searchType,
	isLoading,
	canSearch,
}) => {
	const { colorTheme } = useColorTheme();
	const themeGradient = THEME_GRADIENTS[colorTheme];

	return (
		<div className="space-y-4">
			<form className="flex w-full flex-col gap-4 md:flex-row" onSubmit={onSubmit}>
				<div className="relative flex-1 group">
					<div
						className="pointer-events-none absolute left-4 top-1/2 -translate-y-1/2 transition-colors duration-200"
						style={{ color: "var(--muted-foreground)" }}
					>
						<Search className="h-4 w-4 group-focus-within:opacity-100 opacity-60" />
					</div>
					<Input
						placeholder={`Search for ${searchType === "movie" ? "movies" : "series"} (title, keyword, remote id...)`}
						value={searchInput}
						onChange={(event) => onSearchInputChange(event.target.value)}
						className="pl-11 h-12 bg-card/50 border-border/50 rounded-xl focus:border-transparent transition-all duration-200"
						style={{
							// Focus ring will be handled by the component's own focus styles
						}}
					/>
				</div>
				<Button
					type="submit"
					disabled={!canSearch || searchInput.trim().length === 0 || isLoading}
					className="h-12 px-6 rounded-xl gap-2 font-medium transition-all duration-200 disabled:opacity-50"
					style={{
						background: canSearch && searchInput.trim().length > 0
							? `linear-gradient(135deg, ${themeGradient.from}, ${themeGradient.to})`
							: undefined,
						boxShadow: canSearch && searchInput.trim().length > 0
							? `0 4px 12px -4px ${themeGradient.glow}`
							: undefined,
					}}
				>
					{isLoading ? (
						<>
							<Loader2 className="h-4 w-4 animate-spin" />
							<span>Searching...</span>
						</>
					) : (
						<>
							<Search className="h-4 w-4" />
							<span>Search</span>
						</>
					)}
				</Button>
			</form>

			{/* No Instances Warning */}
			{!canSearch && (
				<div
					className="flex items-center gap-3 rounded-xl px-4 py-3 text-sm animate-in fade-in slide-in-from-top-2"
					style={{
						backgroundColor: SEMANTIC_COLORS.warning.bg,
						border: `1px solid ${SEMANTIC_COLORS.warning.border}`,
					}}
				>
					<div
						className="flex h-8 w-8 items-center justify-center rounded-lg shrink-0"
						style={{
							background: `linear-gradient(135deg, ${SEMANTIC_COLORS.warning.from}20, ${SEMANTIC_COLORS.warning.to}20)`,
							border: `1px solid ${SEMANTIC_COLORS.warning.from}30`,
						}}
					>
						<AlertTriangle className="h-4 w-4" style={{ color: SEMANTIC_COLORS.warning.from }} />
					</div>
					<p className="text-muted-foreground">
						Configure at least one{" "}
						<span className="font-medium text-foreground">
							{searchType === "movie" ? "Radarr" : "Sonarr"}
						</span>{" "}
						instance in{" "}
						<a
							href="/settings"
							className="font-medium underline underline-offset-2 hover:text-foreground transition-colors"
							style={{ color: SEMANTIC_COLORS.warning.from }}
						>
							Settings
						</a>{" "}
						to perform searches.
					</p>
				</div>
			)}
		</div>
	);
};
