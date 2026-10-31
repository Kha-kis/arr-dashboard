"use client";

import { useQueryClient } from "@tanstack/react-query";
import { usePathname, useRouter } from "next/navigation";
import { useEffect, useState, useSyncExternalStore } from "react";
import { useCurrentUser, useSetupRequired } from "../../hooks/api/useAuth";
import { useRestoreState } from "../../hooks/api/useBackup";
import { fetchCurrentUser } from "../../lib/api-client/auth";
import {
	acknowledgeProtectedUnauthorized,
	getPendingUnauthorizedRevision,
	subscribeProtectedUnauthorized,
} from "../../lib/auth-session-signal";
import { authKeys } from "../../lib/query-keys";
import { RestoreRecoveryNotice } from "./restore-recovery-notice";

const PUBLIC_ROUTES = new Set(["/login", "/setup"]);

interface AuthGateProps {
	readonly children: React.ReactNode;
}

export const AuthGate = ({ children }: AuthGateProps) => {
	const pathname = usePathname();
	const router = useRouter();
	const queryClient = useQueryClient();
	const restore = useRestoreState();
	const pendingUnauthorized = useSyncExternalStore(
		subscribeProtectedUnauthorized,
		getPendingUnauthorizedRevision,
		() => 0,
	);
	const [recovery, setRecovery] = useState<{
		pathname: string;
		status: "checking" | "signed-out" | "error";
	} | null>(null);
	const [retryRequested, setRetryRequested] = useState(false);
	const { data: setupRequired } = useSetupRequired();

	const isPublicRoute = PUBLIC_ROUTES.has(pathname);
	const isSetupRoute = pathname === "/setup";
	const currentRecovery = recovery;

	// Only fetch user if setup is complete AND not on a public route
	const shouldFetchUser =
		setupRequired?.required === false && !isSetupRoute && !isPublicRoute && !restore.handoff;
	const {
		data: user,
		isLoading: userLoading,
		isFetching: userFetching,
	} = useCurrentUser(shouldFetchUser);

	useEffect(() => {
		if (
			restore.handoff ||
			isPublicRoute ||
			setupRequired?.required !== false ||
			(pendingUnauthorized === 0 && !retryRequested)
		)
			return;
		let active = true;
		setRecovery({ pathname, status: "checking" });
		void fetchCurrentUser().then(
			(verifiedUser) => {
				if (!active) return;
				if (verifiedUser) {
					queryClient.setQueryData(authKeys.currentUser, verifiedUser);
					if (retryRequested && pendingUnauthorized === 0) {
						queryClient.removeQueries({
							predicate: (query) =>
								query.queryKey[0] !== authKeys.currentUser[0] &&
								query.queryKey[0] !== authKeys.setupRequired[0],
						});
						setRecovery(null);
					} else {
						setRecovery({ pathname, status: "error" });
					}
				} else {
					queryClient.removeQueries({
						predicate: (query) =>
							query.queryKey[0] !== authKeys.currentUser[0] &&
							query.queryKey[0] !== authKeys.setupRequired[0],
					});
					queryClient.setQueryData(authKeys.currentUser, null);
					setRecovery({ pathname, status: "signed-out" });
					router.push(`/login?redirectTo=${encodeURIComponent(pathname)}`);
				}
				setRetryRequested(false);
				acknowledgeProtectedUnauthorized(pendingUnauthorized);
			},
			() => {
				if (!active) return;
				setRecovery({ pathname, status: "error" });
				setRetryRequested(false);
				acknowledgeProtectedUnauthorized(pendingUnauthorized);
			},
		);
		return () => {
			active = false;
		};
	}, [
		isPublicRoute,
		pathname,
		pendingUnauthorized,
		queryClient,
		retryRequested,
		router,
		setupRequired?.required,
		restore.handoff,
	]);

	// Handle auth redirects (but NOT setup redirects - home page handles that)
	useEffect(() => {
		// Don't redirect anything on public routes
		if (isPublicRoute) return;
		if (restore.handoff) return;
		if (pendingUnauthorized !== 0 || currentRecovery) return;

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
	}, [
		setupRequired,
		shouldFetchUser,
		userLoading,
		userFetching,
		user,
		pathname,
		isPublicRoute,
		pendingUnauthorized,
		currentRecovery,
		restore.handoff,
		router,
	]);

	if (restore.handoff) {
		const notice = (
			<RestoreRecoveryNotice
				handoff={restore.handoff}
				pending={restore.pending}
				onClear={() => {
					// The handoff has now been checked and explicitly dismissed.
					// Drop the old document's routing cache as well as its account state.
					window.location.href = "/settings";
				}}
			/>
		);
		return isPublicRoute ? (
			<>
				{notice}
				{children}
			</>
		) : (
			notice
		);
	}

	if (!isPublicRoute && (pendingUnauthorized !== 0 || currentRecovery)) {
		if (currentRecovery?.status === "error" && pendingUnauthorized === 0) {
			return (
				<div role="alert">
					<p>This page could not be loaded safely. Your data is hidden until you retry.</p>
					<button
						type="button"
						onClick={() => {
							setRecovery({ pathname, status: "checking" });
							setRetryRequested(true);
						}}
					>
						Retry page
					</button>
				</div>
			);
		}
		return null;
	}

	// Preserve the initial hydration behavior until a protected request actually fails.
	return <>{children}</>;
};
