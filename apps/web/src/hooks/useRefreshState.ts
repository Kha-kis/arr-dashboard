import { useCallback, useEffect, useRef, useState } from "react";

/**
 * Shared hook for the "refresh with animation" pattern.
 * Returns [isRefreshing, triggerRefresh] where triggerRefresh
 * calls the provided refetch function and shows a brief animation state.
 */
export function useRefreshState(refetchFn: () => Promise<unknown> | void) {
	const [isRefreshing, setIsRefreshing] = useState(false);
	const timeoutRef = useRef<ReturnType<typeof setTimeout>>(undefined);

	useEffect(() => {
		return () => {
			if (timeoutRef.current) clearTimeout(timeoutRef.current);
		};
	}, []);

	const triggerRefresh = useCallback(async () => {
		setIsRefreshing(true);
		try {
			await refetchFn();
		} finally {
			timeoutRef.current = setTimeout(() => setIsRefreshing(false), 500);
		}
	}, [refetchFn]);

	return [isRefreshing, triggerRefresh] as const;
}
