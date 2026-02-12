"use client";

import Link from "next/link";
import { useSearchIndexersQuery } from "../../../hooks/api/useSearch";
import {
	Button,
	Alert,
	AlertTitle,
	AlertDescription,
	Pagination,
} from "../../../components/ui";
import { PremiumCard, PremiumSkeleton } from "../../../components/layout";
import { SearchResultsTable } from "./search-results-table";
import { IndexerSelector } from "./indexer-selector";
import { SearchForm } from "./search-form";
import { FilterControls } from "./filter-controls";
import { SortControls } from "./sort-controls";
import { ResultsSummary } from "./results-summary";
import { useSearchState } from "../hooks/use-search-state";
import { useSearchData } from "../hooks/use-search-data";
import { useSearchPagination } from "../hooks/use-search-pagination";
import { useSearchActions } from "../hooks/use-search-actions";
import { useSearchIndexers } from "../hooks/use-search-indexers";
import { useThemeGradient } from "../../../hooks/useThemeGradient";
import { Search, Settings, Globe } from "lucide-react";

/**
 * Main search client component for manual indexer searches.
 */
export const SearchClient = () => {
	const { gradient: themeGradient } = useThemeGradient();

	// Search state management
	const searchState = useSearchState();
	const {
		query,
		searchType,
		selectedIndexers,
		validationError,
		feedback,
		grabbingKey,
		hasSearched,
		filters,
		sort,
		actions,
	} = searchState;

	// Indexers data
	const indexersQuery = useSearchIndexersQuery();

	// Initialize indexer selection
	useSearchIndexers(indexersQuery, actions);

	// Search and action handlers
	const {
		results,
		handleSearch: _handleSearch,
		handleSubmit,
		handleGrab,
		handleCopyMagnet,
		handleOpenInfo,
		isSearching,
	} = useSearchActions(query, searchType, selectedIndexers, actions);

	// Filter and sort results
	const processed = useSearchData(results, {
		...filters,
		...sort,
	});

	// Pagination
	const { page, pageSize, paginatedResults, setPage, setPageSize } =
		useSearchPagination(processed.results);

	// Loading skeleton
	if (indexersQuery.isLoading) {
		return (
			<div className="space-y-8 animate-in fade-in duration-500">
				<div className="space-y-4">
					<PremiumSkeleton variant="line" className="h-8 w-48" />
					<PremiumSkeleton variant="line" className="h-10 w-64" style={{ animationDelay: "50ms" }} />
				</div>
				<div className="rounded-2xl border border-border/30 bg-card/30 p-6">
					<div className="space-y-4">
						<PremiumSkeleton variant="card" className="h-10 w-full" style={{ animationDelay: "100ms" }} />
						<PremiumSkeleton variant="card" className="h-32 w-full" style={{ animationDelay: "150ms" }} />
					</div>
				</div>
			</div>
		);
	}

	if (indexersQuery.error) {
		return (
			<Alert variant="danger">
				<AlertTitle>Unable to load indexers</AlertTitle>
				<AlertDescription>Please verify your API connection and try again.</AlertDescription>
			</Alert>
		);
	}

	const noIndexers = !indexersQuery.data || indexersQuery.data.totalCount === 0;
	const emptyMessage = !hasSearched
		? "Submit a manual search to see results across your indexers."
		: results.length === 0
			? "No results returned from your indexers for that query."
			: processed.filtersActive
				? "No results match the current filters. Adjust them to see more releases."
				: "No results to display.";

	return (
		<>
			{/* Header */}
			<header
				className="relative animate-in fade-in slide-in-from-bottom-4 duration-500"
				style={{ animationFillMode: "backwards" }}
			>
				<div className="flex items-start justify-between gap-4">
					<div className="space-y-1">
						{/* Label with icon */}
						<div className="flex items-center gap-2 text-sm text-muted-foreground">
							<Search className="h-4 w-4" />
							<span>Multi-indexer Search</span>
						</div>

						{/* Gradient title */}
						<h1 className="text-3xl font-bold tracking-tight">
							<span
								style={{
									background: `linear-gradient(135deg, ${themeGradient.from}, ${themeGradient.to})`,
									WebkitBackgroundClip: "text",
									WebkitTextFillColor: "transparent",
									backgroundClip: "text",
								}}
							>
								Manual Search
							</span>
						</h1>

						{/* Description */}
						<p className="text-muted-foreground max-w-xl">
							Query your configured Prowlarr instances and send releases directly to your download
							clients
						</p>
					</div>
				</div>
			</header>

			{/* Alerts */}
			{feedback && (
				<Alert variant={feedback.type === "success" ? "success" : "danger"}>
					<AlertDescription>{feedback.message}</AlertDescription>
				</Alert>
			)}

			{validationError && (
				<Alert variant="warning">
					<AlertDescription>{validationError}</AlertDescription>
				</Alert>
			)}

			{noIndexers ? (
				<div
					className="rounded-2xl border-2 border-dashed border-border/50 bg-card/20 p-8 text-center animate-in fade-in slide-in-from-bottom-4 duration-500"
					style={{ animationDelay: "100ms", animationFillMode: "backwards" }}
				>
					<div
						className="mx-auto mb-4 flex h-16 w-16 items-center justify-center rounded-2xl"
						style={{
							background: `linear-gradient(135deg, ${themeGradient.from}20, ${themeGradient.to}20)`,
							border: `1px solid ${themeGradient.from}30`,
						}}
					>
						<Globe className="h-8 w-8" style={{ color: themeGradient.from }} />
					</div>
					<h3 className="text-xl font-semibold mb-2">Prowlarr Configuration Required</h3>
					<p className="text-muted-foreground mb-6 max-w-md mx-auto">
						Add at least one Prowlarr instance in Settings to enable manual searches across your
						indexers.
					</p>
					<Button asChild>
						<Link href="/settings" className="gap-2">
							<Settings className="h-4 w-4" />
							Open Settings
						</Link>
					</Button>
				</div>
			) : (
				<>
					{/* Search Configuration Card */}
					<PremiumCard
						title="Search Configuration"
						description="Choose indexers and a search type, then run a manual query"
						icon={Search}
						gradientIcon={false}
						animationDelay={100}
					>
						<div className="space-y-6">
							<SearchForm
								query={query}
								searchType={searchType}
								isSearching={isSearching}
								onQueryChange={actions.setQuery}
								onSearchTypeChange={actions.setSearchType}
								onSubmit={handleSubmit}
							/>

							{indexersQuery.data && (
								<IndexerSelector
									indexersData={indexersQuery.data}
									selectedIndexers={selectedIndexers}
									onToggleIndexer={actions.handleToggleIndexer}
									onToggleAll={actions.handleToggleAll}
								/>
							)}

							<FilterControls
								protocolFilter={filters.protocolFilter}
								minSeedersInput={filters.minSeedersInput}
								maxAgeInput={filters.maxAgeInput}
								hideRejected={filters.hideRejected}
								onProtocolFilterChange={actions.setProtocolFilter}
								onMinSeedersChange={actions.setMinSeedersInput}
								onMaxAgeChange={actions.setMaxAgeInput}
								onHideRejectedToggle={() => actions.setHideRejected((value) => !value)}
								onReset={actions.resetFilters}
							/>

							<SortControls
								sortKey={sort.sortKey}
								sortDirection={sort.sortDirection}
								onSortKeyChange={actions.setSortKey}
								onSortDirectionChange={actions.setSortDirection}
							/>
						</div>
					</PremiumCard>

					{/* Results Summary */}
					{(hasSearched || results.length > 0) && (
						<div
							className="animate-in fade-in slide-in-from-bottom-4 duration-500"
							style={{ animationDelay: "200ms", animationFillMode: "backwards" }}
						>
							<ResultsSummary
								displayedCount={processed.results.length}
								totalCount={results.length}
								hiddenCount={processed.hidden}
								filtersActive={processed.filtersActive}
							/>
						</div>
					)}

					{/* Pagination Top */}
					{processed.results.length > 0 && (
						<div
							className="animate-in fade-in slide-in-from-bottom-4 duration-500"
							style={{ animationDelay: "250ms", animationFillMode: "backwards" }}
						>
							<Pagination
								currentPage={page}
								totalItems={processed.results.length}
								pageSize={pageSize}
								onPageChange={setPage}
								onPageSizeChange={(size) => {
									setPageSize(size);
									setPage(1);
								}}
								pageSizeOptions={[25, 50, 100]}
							/>
						</div>
					)}

					{/* Results Table */}
					<div
						className="animate-in fade-in slide-in-from-bottom-4 duration-500"
						style={{ animationDelay: "300ms", animationFillMode: "backwards" }}
					>
						<SearchResultsTable
							results={paginatedResults}
							loading={isSearching}
							onGrab={handleGrab}
							grabbingKey={grabbingKey}
							onCopyMagnet={handleCopyMagnet}
							onOpenInfo={handleOpenInfo}
							emptyMessage={emptyMessage}
						/>
					</div>

					{/* Pagination Bottom */}
					{processed.results.length > 0 && (
						<Pagination
							currentPage={page}
							totalItems={processed.results.length}
							pageSize={pageSize}
							onPageChange={setPage}
							onPageSizeChange={setPageSize}
							pageSizeOptions={[25, 50, 100]}
						/>
					)}
				</>
			)}
		</>
	);
};
