'use client';

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

  // Only fetch user if setup is definitely complete (false, not undefined)
  const shouldFetchUser = setupRequired === false && !isSetupRoute;
  const { data: user, isLoading: userLoading } = useCurrentUser(shouldFetchUser);

  // Handle auth redirects (but NOT setup redirects - home page handles that)
  useEffect(() => {
    console.log('AuthGate:', { pathname, setupRequired, userLoading, user: !!user, isPublicRoute });

    // Don't redirect anything on public routes
    if (isPublicRoute) return;

    // Only handle redirects if setup is complete
    if (setupRequired !== false) return;
    if (userLoading) return;

    // Redirect to login if not authenticated on protected route
    if (!user) {
      const redirectTo = encodeURIComponent(pathname);
      router.push(`/login?redirectTo=${redirectTo}`);
      return;
    }

    // Redirect logged-in users away from login (handled above by isPublicRoute check)
  }, [setupRequired, userLoading, user, pathname, isPublicRoute, router]);

  // Always render children immediately to avoid hydration issues
  return <>{children}</>;
};
