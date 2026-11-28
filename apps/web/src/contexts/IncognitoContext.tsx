"use client";

import { createContext, type ReactNode, useContext, useEffect, useState } from "react";

const INCOGNITO_STORAGE_KEY = "arr-dashboard-incognito-mode";

interface IncognitoContextValue {
	incognitoMode: boolean;
	setIncognitoMode: (value: boolean) => void;
}

const IncognitoContext = createContext<IncognitoContextValue | undefined>(undefined);

export function IncognitoProvider({ children }: { children: ReactNode }) {
	// Keep server and first client render masked until the preference is known.
	const [incognitoMode, setIncognitoModeState] = useState(true);
	const [mounted, setMounted] = useState(false);

	// Load from localStorage only after mounting on client
	useEffect(() => {
		setMounted(true);
		if (typeof window !== "undefined") {
			try {
				setIncognitoModeState(localStorage.getItem(INCOGNITO_STORAGE_KEY) === "true");
			} catch {
				// Unavailable storage must not expose private content or prevent rendering.
			}
		}
	}, []);

	// Listen for storage changes to sync incognito mode across tabs
	useEffect(() => {
		if (!mounted) return;

		const handleStorageChange = (e: StorageEvent) => {
			if (e.key === INCOGNITO_STORAGE_KEY) {
				setIncognitoModeState(e.newValue === "true");
			}
		};

		const handleCustomEvent = () => {
			try {
				setIncognitoModeState(localStorage.getItem(INCOGNITO_STORAGE_KEY) === "true");
			} catch {
				// Preserve the current session's explicit choice when storage is unavailable.
			}
		};

		window.addEventListener("storage", handleStorageChange);
		window.addEventListener("incognito-mode-changed", handleCustomEvent);

		return () => {
			window.removeEventListener("storage", handleStorageChange);
			window.removeEventListener("incognito-mode-changed", handleCustomEvent);
		};
	}, [mounted]);

	const setIncognitoMode = (value: boolean) => {
		setIncognitoModeState(value);
		if (typeof window !== "undefined") {
			try {
				localStorage.setItem(INCOGNITO_STORAGE_KEY, String(value));
			} catch {
				// This explicit choice is session-only; do not announce a persisted change.
				return;
			}
			window.dispatchEvent(new Event("incognito-mode-changed"));
		}
	};

	return (
		<IncognitoContext.Provider value={{ incognitoMode, setIncognitoMode }}>
			{children}
		</IncognitoContext.Provider>
	);
}

export function useIncognitoMode() {
	const context = useContext(IncognitoContext);
	if (context === undefined) {
		throw new Error("useIncognitoMode must be used within an IncognitoProvider");
	}
	return [context.incognitoMode, context.setIncognitoMode] as const;
}
