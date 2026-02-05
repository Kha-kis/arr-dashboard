"use client";

import { useEffect } from "react";
import { usePathname, useRouter } from "next/navigation";
import { useCurrentUser, useSetupRequired } from "../../hooks/api/useAuth";

const PUBLIC_ROUTES = new Set(["/login", "/setup"]);

interface AuthGateProps {
	readonly children: React.ReactNode;
}

export const AuthGate = ({ children }: AuthGateProps) => {
	const pathname = usePathname();
	const router = useRouter();
	const { data: setupRequired } = useSetupRequired();

	const isPublicRoute = PUBLIC_ROUTES.has(pathname);
	const isSetupRoute = pathname === "/setup";

	// Only fetch user if setup is complete AND not on a public route
	const shouldFetchUser = setupRequired?.required === false && !isSetupRoute && !isPublicRoute;
	const { data: user, isLoading: userLoading, isFetching: userFetching } = useCurrentUser(shouldFetchUser);

	// Handle auth redirects (but NOT setup redirects - home page handles that)
	useEffect(() => {
		// Don't redirect anything on public routes
		if (isPublicRoute) return;

		// Only handle redirects if setup is complete
		if (setupRequired?.required !== false) return;

		// Don't redirect if user query is disabled, still loading, or actively fetching
		if (!shouldFetchUser || userLoading || userFetching) return;

		// Redirect to login if not authenticated on protected route
		if (!user) {
			const redirectTo = encodeURIComponent(pathname);
			router.push(`/login?redirectTo=${redirectTo}`);
			return;
		}

		// Redirect logged-in users away from login (handled above by isPublicRoute check)
	}, [setupRequired, shouldFetchUser, userLoading, userFetching, user, pathname, isPublicRoute, router]);

	// Always render children immediately to avoid hydration issues
	return <>{children}</>;
};
