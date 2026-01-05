"use client";

import { QueryClient, QueryClientProvider } from "@tanstack/react-query";
import { ReactQueryDevtools } from "@tanstack/react-query-devtools";
import { ThemeProvider } from "next-themes";
import React from "react";
import { IncognitoProvider } from "../contexts/IncognitoContext";
import { ColorThemeProvider } from "./color-theme-provider";

interface RootProvidersProps {
	readonly children: React.ReactNode;
}

export const RootProviders: React.FC<RootProvidersProps> = ({ children }) => {
	const [queryClient] = React.useState(
		() =>
			new QueryClient({
				defaultOptions: {
					queries: {
						refetchOnWindowFocus: false,
						staleTime: 1000 * 30, // 30 seconds
						gcTime: 1000 * 60 * 5, // 5 minutes - garbage collect unused queries
						retry: 1,
						// Limit how much data polling queries can accumulate
						structuralSharing: true, // Reuse unchanged data references (memory optimization)
					},
				},
			}),
	);

	return (
		<ThemeProvider attribute="class" defaultTheme="system" enableSystem>
			<ColorThemeProvider>
				<QueryClientProvider client={queryClient}>
					<IncognitoProvider>
						{children}
						{/* Only include DevTools in development to prevent memory overhead in production */}
						{process.env.NODE_ENV === "development" && (
							<ReactQueryDevtools initialIsOpen={false} buttonPosition="bottom-right" />
						)}
					</IncognitoProvider>
				</QueryClientProvider>
			</ColorThemeProvider>
		</ThemeProvider>
	);
};
