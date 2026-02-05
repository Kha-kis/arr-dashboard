"use client";

import { useEffect } from "react";
import { useRouter } from "next/navigation";
import { useSetupRequired, useCurrentUser } from "../src/hooks/api/useAuth";
import { Skeleton } from "../src/components/ui";

const HomePage = () => {
	const router = useRouter();
	const { data: setupRequired, isLoading: setupLoading, error: setupError } = useSetupRequired();
	const { data: user, isLoading: userLoading } = useCurrentUser(setupRequired?.required === false);

	useEffect(() => {
		if (setupLoading) return;

		// On error, redirect to login page (which has error handling UI)
		if (setupError) {
			router.replace("/login");
			return;
		}

		// Setup is required, go to setup page
		if (setupRequired?.required === true) {
			window.location.href = "/setup";
			return;
		}

		// Setup is complete, check auth
		if (setupRequired?.required === false) {
			if (userLoading) return;

			// User is logged in, go to dashboard
			if (user) {
				router.replace("/dashboard");
				return;
			}

			// Not logged in, go to login
			router.replace("/login");
		}
	}, [setupLoading, setupRequired, setupError, userLoading, user, router]);

	return (
		<main className="flex min-h-screen flex-col items-center justify-center gap-6 bg-linear-to-br from-slate-900 via-slate-800 to-slate-900 text-white">
			<Skeleton className="h-10 w-10 rounded-full" />
		</main>
	);
};

export default HomePage;
