"use client";

import { useCallback, useEffect, useMemo, useState } from "react";
import Link from "next/link";
import type { SearchResult } from "@arr/shared";
import {
	useSearchIndexersQuery,
	useManualSearchMutation,
	useGrabSearchResultMutation,
} from "../../../hooks/api/useSearch";
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
import { safeOpenUrl } from "../../../lib/utils/url-validation";
import { IndexerSelector } from "./indexer-selector";
import { SearchForm } from "./search-form";
import { FilterControls } from "./filter-controls";
import { SortControls } from "./sort-controls";
import { ResultsSummary } from "./results-summary";
import { buildFilters, deriveGrabErrorMessage } from "../lib/search-utils";
import { useSearchState } from "../hooks/use-search-state";
import { useSearchData } from "../hooks/use-search-data";

export const SearchClient = () => {
	const [results, setResults] = useState<SearchResult[]>([]);
	const [page, setPage] = useState(1);
	const [pageSize, setPageSize] = useState(25);

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

	const indexersQuery = useSearchIndexersQuery();
	const searchMutation = useManualSearchMutation();
	const grabMutation = useGrabSearchResultMutation();

	const processed = useSearchData(results, {
		...filters,
		...sort,
	});

	const paginatedResults = useMemo(() => {
		const start = (page - 1) * pageSize;
		return processed.results.slice(start, start + pageSize);
	}, [processed.results, page, pageSize]);

	useEffect(() => {
		if (!indexersQuery.data || indexersQuery.data.instances.length === 0) {
			actions.setSelectedIndexers({});
			return;
		}

		actions.setSelectedIndexers((current) => {
			if (Object.keys(current).length > 0) {
				return current;
			}

			const initial: Record<string, number[]> = {};
			for (const instance of indexersQuery.data.instances) {
				const enabled = instance.data
					.filter((indexer) => indexer.enable)
					.map((indexer) => indexer.id);
				initial[instance.instanceId] = enabled;
			}
			return initial;
		});
	}, [indexersQuery.data, actions]);

	const handleSearch = () => {
		if (!query.trim()) {
			actions.setValidationError("Enter a search query first.");
			actions.setFeedback(null);
			return;
		}

		const filterPayload = buildFilters(selectedIndexers);
		if (filterPayload.length === 0) {
			actions.setValidationError("Select at least one indexer to search against.");
			actions.setFeedback(null);
			return;
		}

		actions.setValidationError(null);
		actions.setFeedback(null);

		searchMutation.mutate(
			{
				query: query.trim(),
				type: searchType,
				filters: filterPayload,
			},
			{
				onSuccess: (data) => {
					actions.setHasSearched(true);
					setResults(data.aggregated);
					const total = data.totalCount;
					actions.setFeedback({
						type: "success",
						message:
							total > 0
								? `Found ${total} result${total === 1 ? "" : "s"}.`
								: "No results found for that query.",
					});
				},
				onError: (error) => {
					const message = error instanceof Error ? error.message : "Search failed";
					actions.setFeedback({ type: "error", message });
				},
			},
		);
	};

	const handleSubmit = (event: React.FormEvent) => {
		event.preventDefault();
		if (!searchMutation.isPending) {
			handleSearch();
		}
	};

	const handleGrab = async (result: SearchResult) => {
		const rowKey = `${result.instanceId}:${result.indexerId}:${result.id}`;
		actions.setGrabbingKey(rowKey);
		actions.setFeedback(null);
		try {
			await grabMutation.mutateAsync({
				instanceId: result.instanceId,
				result,
			});
			actions.setFeedback({
				type: "success",
				message: `Sent "${result.title}" to the download client.`,
			});
		} catch (error) {
			const message = deriveGrabErrorMessage(error);
			actions.setFeedback({ type: "error", message });
		} finally {
			actions.setGrabbingKey(null);
		}
	};

	const handleCopyMagnet = useCallback(
		async (result: SearchResult) => {
			const link = result.magnetUrl ?? result.downloadUrl ?? result.link;
			if (!link) {
				actions.setFeedback({
					type: "error",
					message: "No copyable magnet or download link is available for this release.",
				});
				return;
			}

			try {
				await navigator.clipboard.writeText(link);
				actions.setFeedback({ type: "success", message: "Copied link to clipboard." });
			} catch (error) {
				const message = error instanceof Error ? error.message : "Clipboard copy failed.";
				actions.setFeedback({
					type: "error",
					message: `Unable to copy link: ${message}`,
				});
			}
		},
		[actions],
	);

	const handleOpenInfo = useCallback(
		(result: SearchResult) => {
			const target = result.infoUrl ?? result.link ?? result.downloadUrl ?? result.magnetUrl;
			if (!target) {
				actions.setFeedback({
					type: "error",
					message: "This release did not provide a public info link.",
				});
				return;
			}
			if (!safeOpenUrl(target)) {
				actions.setFeedback({ type: "error", message: "Invalid or unsafe URL." });
			}
		},
		[actions],
	);

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
								isSearching={searchMutation.isPending}
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
						loading={searchMutation.isPending}
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
							onPageSizeChange={(size) => {
								setPageSize(size);
								setPage(1);
							}}
							pageSizeOptions={[25, 50, 100]}
						/>
					)}
				</>
			)}
		</section>
	);
};
