"use client";

import { createContext, useContext, useState, useEffect, type ReactNode } from "react";

const INCOGNITO_STORAGE_KEY = "arr-dashboard-incognito-mode";

interface IncognitoContextValue {
	incognitoMode: boolean;
	setIncognitoMode: (value: boolean) => void;
}

const IncognitoContext = createContext<IncognitoContextValue | undefined>(undefined);

export function IncognitoProvider({ children }: { children: ReactNode }) {
	const [incognitoMode, setIncognitoModeState] = useState(false);
	const [mounted, setMounted] = useState(false);

	// Load from localStorage only after mounting on client
	useEffect(() => {
		setMounted(true);
		if (typeof window !== "undefined") {
			const stored = localStorage.getItem(INCOGNITO_STORAGE_KEY);
			if (stored === "true") {
				setIncognitoModeState(true);
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
			const stored = localStorage.getItem(INCOGNITO_STORAGE_KEY);
			setIncognitoModeState(stored === "true");
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
			localStorage.setItem(INCOGNITO_STORAGE_KEY, String(value));
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
