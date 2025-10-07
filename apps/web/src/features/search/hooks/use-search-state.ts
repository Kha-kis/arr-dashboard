import { useCallback, useMemo, useState } from "react";
import type { ProtocolFilter, SortKey } from "../lib/search-utils";

export interface SearchFilters {
	protocolFilter: ProtocolFilter;
	minSeedersInput: string;
	maxAgeInput: string;
	hideRejected: boolean;
}

export interface SearchSort {
	sortKey: SortKey;
	sortDirection: "asc" | "desc";
}

export interface SearchStateActions {
	setQuery: (query: string) => void;
	setSearchType: (type: "all" | "movie" | "tv" | "music" | "book") => void;
	setSelectedIndexers: React.Dispatch<React.SetStateAction<Record<string, number[]>>>;
	setValidationError: (error: string | null) => void;
	setFeedback: (feedback: { type: "success" | "error"; message: string } | null) => void;
	setGrabbingKey: (key: string | null) => void;
	setHasSearched: (searched: boolean) => void;
	setProtocolFilter: (filter: ProtocolFilter) => void;
	setMinSeedersInput: (value: string) => void;
	setMaxAgeInput: (value: string) => void;
	setHideRejected: React.Dispatch<React.SetStateAction<boolean>>;
	setSortKey: (key: SortKey) => void;
	setSortDirection: (direction: "asc" | "desc") => void;
	resetFilters: () => void;
	handleToggleIndexer: (instanceId: string, indexerId: number) => void;
	handleToggleAll: (instanceId: string, ids: number[]) => void;
}

export interface SearchState {
	query: string;
	searchType: "all" | "movie" | "tv" | "music" | "book";
	selectedIndexers: Record<string, number[]>;
	validationError: string | null;
	feedback: { type: "success" | "error"; message: string } | null;
	grabbingKey: string | null;
	hasSearched: boolean;
	filters: SearchFilters;
	sort: SearchSort;
	actions: SearchStateActions;
}

/**
 * Manages all state for the search feature
 */
export const useSearchState = (): SearchState => {
	const [query, setQuery] = useState("");
	const [searchType, setSearchType] = useState<"all" | "movie" | "tv" | "music" | "book">("movie");
	const [selectedIndexers, setSelectedIndexers] = useState<Record<string, number[]>>({});
	const [validationError, setValidationError] = useState<string | null>(null);
	const [feedback, setFeedback] = useState<{
		type: "success" | "error";
		message: string;
	} | null>(null);
	const [grabbingKey, setGrabbingKey] = useState<string | null>(null);
	const [hasSearched, setHasSearched] = useState(false);
	const [protocolFilter, setProtocolFilter] = useState<ProtocolFilter>("all");
	const [minSeedersInput, setMinSeedersInput] = useState("");
	const [maxAgeInput, setMaxAgeInput] = useState("");
	const [hideRejected, setHideRejected] = useState(false);
	const [sortKey, setSortKey] = useState<SortKey>("seeders");
	const [sortDirection, setSortDirection] = useState<"asc" | "desc">("desc");

	const handleToggleIndexer = useCallback((instanceId: string, indexerId: number) => {
		setSelectedIndexers((current) => {
			const existing = new Set(current[instanceId] ?? []);
			if (existing.has(indexerId)) {
				existing.delete(indexerId);
			} else {
				existing.add(indexerId);
			}
			const next = { ...current, [instanceId]: Array.from(existing) };
			setValidationError(null);
			return next;
		});
	}, []);

	const handleToggleAll = useCallback((instanceId: string, ids: number[]) => {
		setSelectedIndexers((current) => {
			const existing = new Set(current[instanceId] ?? []);
			const everySelected = ids.every((id) => existing.has(id));
			const nextIds = everySelected ? [] : ids;
			const next = { ...current, [instanceId]: nextIds };
			setValidationError(null);
			return next;
		});
	}, []);

	const resetFilters = useCallback(() => {
		setProtocolFilter("all");
		setMinSeedersInput("");
		setMaxAgeInput("");
		setHideRejected(false);
		setSortKey("seeders");
		setSortDirection("desc");
	}, []);

	const actions = useMemo(
		() => ({
			setQuery,
			setSearchType,
			setSelectedIndexers,
			setValidationError,
			setFeedback,
			setGrabbingKey,
			setHasSearched,
			setProtocolFilter,
			setMinSeedersInput,
			setMaxAgeInput,
			setHideRejected,
			setSortKey,
			setSortDirection,
			resetFilters,
			handleToggleIndexer,
			handleToggleAll,
		}),
		[resetFilters, handleToggleIndexer, handleToggleAll],
	);

	return {
		query,
		searchType,
		selectedIndexers,
		validationError,
		feedback,
		grabbingKey,
		hasSearched,
		filters: {
			protocolFilter,
			minSeedersInput,
			maxAgeInput,
			hideRejected,
		},
		sort: {
			sortKey,
			sortDirection,
		},
		actions,
	};
};
