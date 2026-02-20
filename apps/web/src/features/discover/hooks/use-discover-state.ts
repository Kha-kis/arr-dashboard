"use client";

import { useState, useCallback, useRef, useEffect } from "react";
import type { SeerrDiscoverResult } from "@arr/shared";

export type DiscoverMediaType = "movie" | "tv";

export interface DiscoverState {
	mediaType: DiscoverMediaType;
	searchInput: string;
	debouncedQuery: string;
	selectedItem: SeerrDiscoverResult | null;
	requestItem: SeerrDiscoverResult | null;
}

export function useDiscoverState() {
	const [mediaType, setMediaType] = useState<DiscoverMediaType>("movie");
	const [searchInput, setSearchInput] = useState("");
	const [debouncedQuery, setDebouncedQuery] = useState("");
	const [selectedItem, setSelectedItem] = useState<SeerrDiscoverResult | null>(null);
	const [requestItem, setRequestItem] = useState<SeerrDiscoverResult | null>(null);
	const [selectedGenreId, setSelectedGenreId] = useState<number | null>(null);
	const [hideAvailable, setHideAvailable] = useState(false);
	const debounceRef = useRef<ReturnType<typeof setTimeout>>(null);

	// Debounce search input by 300ms
	useEffect(() => {
		if (debounceRef.current) clearTimeout(debounceRef.current);
		debounceRef.current = setTimeout(() => {
			setDebouncedQuery(searchInput.trim());
		}, 300);
		return () => {
			if (debounceRef.current) clearTimeout(debounceRef.current);
		};
	}, [searchInput]);

	const clearSearch = useCallback(() => {
		setSearchInput("");
		setDebouncedQuery("");
	}, []);

	const selectItem = useCallback((item: SeerrDiscoverResult) => {
		setSelectedItem(item);
	}, []);

	const closeDetail = useCallback(() => {
		setSelectedItem(null);
	}, []);

	const openRequest = useCallback((item: SeerrDiscoverResult) => {
		setRequestItem(item);
	}, []);

	const closeRequest = useCallback(() => {
		setRequestItem(null);
	}, []);

	const handleMediaTypeChange = useCallback((type: DiscoverMediaType) => {
		setMediaType(type);
		setSearchInput("");
		setDebouncedQuery("");
		setSelectedGenreId(null);
	}, []);

	return {
		mediaType,
		searchInput,
		debouncedQuery,
		selectedItem,
		requestItem,
		selectedGenreId,
		hideAvailable,
		setSearchInput,
		setMediaType: handleMediaTypeChange,
		setSelectedGenreId,
		setHideAvailable,
		clearSearch,
		selectItem,
		closeDetail,
		openRequest,
		closeRequest,
	};
}
