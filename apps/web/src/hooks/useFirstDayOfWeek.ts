import { useCallback, useState } from "react";

const STORAGE_KEY = "arr-first-day-of-week";

export type WeekStart = 0 | 1;

function getInitialWeekStart(): WeekStart {
	if (typeof window === "undefined") return 0;

	try {
		const stored = localStorage.getItem(STORAGE_KEY);
		if (stored === "1") return 1;
	} catch {
		// localStorage not available
	}
	return 0;
}

export function useFirstDayOfWeek() {
	const [weekStart, setWeekStartState] = useState<WeekStart>(getInitialWeekStart);

	const setWeekStart = useCallback((day: WeekStart) => {
		setWeekStartState(day);
		try {
			localStorage.setItem(STORAGE_KEY, String(day));
		} catch {
			// localStorage not available
		}
	}, []);

	return { weekStart, setWeekStart };
}
