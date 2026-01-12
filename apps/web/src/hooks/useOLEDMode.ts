/**
 * useOLEDMode Hook
 *
 * Manages OLED dark mode preference (pure black backgrounds).
 * Works alongside next-themes dark mode - OLED only applies when dark mode is active.
 *
 * @example
 * ```tsx
 * const { isOLED, setOLED, toggleOLED } = useOLEDMode();
 *
 * return (
 *   <button onClick={toggleOLED}>
 *     {isOLED ? "Disable OLED" : "Enable OLED"}
 *   </button>
 * );
 * ```
 */

import { useState, useEffect, useCallback } from "react";

const STORAGE_KEY = "arr-oled-mode";

/**
 * Get initial OLED state from localStorage or DOM attribute
 */
function getInitialOLEDState(): boolean {
	if (typeof window === "undefined") return false;

	// Check DOM attribute first (set by blocking script if we had one)
	const domOLED = document.documentElement.getAttribute("data-oled");
	if (domOLED === "true") return true;

	// Fall back to localStorage
	try {
		const stored = localStorage.getItem(STORAGE_KEY);
		return stored === "true";
	} catch {
		return false;
	}
}

export function useOLEDMode() {
	const [isOLED, setIsOLED] = useState(getInitialOLEDState);
	const [mounted, setMounted] = useState(false);

	// Mark as mounted after hydration
	useEffect(() => {
		setMounted(true);
	}, []);

	// Sync with DOM and localStorage
	useEffect(() => {
		if (!mounted) return;

		// Update DOM attribute
		if (isOLED) {
			document.documentElement.setAttribute("data-oled", "true");
		} else {
			document.documentElement.removeAttribute("data-oled");
		}

		// Persist to localStorage
		try {
			localStorage.setItem(STORAGE_KEY, String(isOLED));
		} catch {
			// localStorage not available
		}
	}, [isOLED, mounted]);

	const setOLED = useCallback((enabled: boolean) => {
		setIsOLED(enabled);
	}, []);

	const toggleOLED = useCallback(() => {
		setIsOLED((prev) => !prev);
	}, []);

	return {
		isOLED,
		setOLED,
		toggleOLED,
	};
}
