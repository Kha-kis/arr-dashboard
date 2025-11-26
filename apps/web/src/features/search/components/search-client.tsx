"use client";

import Link from "next/link";
import { useSearchIndexersQuery } from "../../../hooks/api/useSearch";
import {
	Button,
	Card,
	CardContent,
	CardDescription,
	CardHeader,
	CardTitle,
	Alert,
	AlertTitle,
	AlertDescription,
	Skeleton,
	Pagination,
} from "../../../components/ui";
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

/**
 * Main search client component for manual indexer searches.
 * Orchestrates the search flow including:
 * - Indexer selection and initialization
 * - Search query and filtering
 * - Results display and pagination
 * - Grabbing releases and copying links
 *
 * Refactored to use business logic hooks for better separation of concerns.
 *
 * @component
 */
export const SearchClient = () => {
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
		handleSearch,
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

	if (indexersQuery.isLoading) {
		return (
			<div className="space-y-6">
				<Skeleton className="h-20 w-full" />
				<Skeleton className="h-96 w-full" />
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
		<section className="flex flex-col gap-10">
			<header className="flex flex-col gap-2 md:flex-row md:items-end md:justify-between">
				<div>
					<p className="text-sm font-medium uppercase text-white/60">Multi-indexer search</p>
					<h1 className="text-3xl font-semibold text-white">Manual Search</h1>
					<p className="mt-2 text-sm text-white/60">
						Query your configured Prowlarr instances and send releases directly to your download
						clients.
					</p>
				</div>
			</header>

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
				<Card className="border-dashed border-white/20 bg-white/5">
					<CardHeader>
						<CardTitle className="text-xl">Prowlarr configuration required</CardTitle>
						<CardDescription>
							Add at least one Prowlarr instance in Settings to enable manual searches across your
							indexers.
						</CardDescription>
					</CardHeader>
					<CardContent>
						<Button asChild>
							<Link href="/settings">Open Settings</Link>
						</Button>
					</CardContent>
				</Card>
			) : (
				<>
					<Card>
						<CardHeader className="mb-0">
							<CardTitle>Search configuration</CardTitle>
							<CardDescription>
								Choose indexers and a search type, then run a manual query. Results refresh
								automatically on each search.
							</CardDescription>
						</CardHeader>
						<CardContent className="space-y-6">
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
						</CardContent>
					</Card>

					{(hasSearched || results.length > 0) && (
						<ResultsSummary
							displayedCount={processed.results.length}
							totalCount={results.length}
							hiddenCount={processed.hidden}
							filtersActive={processed.filtersActive}
						/>
					)}

					{processed.results.length > 0 && (
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
					)}

					<SearchResultsTable
						results={paginatedResults}
						loading={isSearching}
						onGrab={handleGrab}
						grabbingKey={grabbingKey}
						onCopyMagnet={handleCopyMagnet}
						onOpenInfo={handleOpenInfo}
						emptyMessage={emptyMessage}
					/>

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
		</section>
	);
};
