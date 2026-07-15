"use client";

import { useRouter, useSearchParams } from "next/navigation";
import { Suspense, useEffect } from "react";
import { Skeleton } from "../../src/components/ui";
import { SetupClient } from "../../src/features/setup/components/setup-client";
import { useCurrentUser, useSetupRequired } from "../../src/hooks/api/useAuth";

const SetupLoading = () => (
	<main className="flex min-h-screen items-center justify-center bg-background px-4">
		<Skeleton className="h-10 w-10 rounded-full" />
	</main>
);

const SetupPageContent = () => {
	const router = useRouter();
	const searchParams = useSearchParams();
	const requestedStage = searchParams.get("stage");
	const requestedAuthenticatedStage =
		requestedStage === "services" || requestedStage === "starters" || requestedStage === "console";
	const requestedSetupPath =
		requestedStage === "console"
			? "/setup?stage=console"
			: requestedStage === "starters"
				? "/setup?stage=starters"
				: "/setup?stage=services";
	const { data: setupRequired, isLoading } = useSetupRequired();
	const shouldVerifySession = setupRequired?.required === false && requestedAuthenticatedStage;
	const { data: user, isLoading: userLoading } = useCurrentUser(shouldVerifySession);

	useEffect(() => {
		if (isLoading || userLoading) return;

		if (setupRequired?.required === false && !requestedAuthenticatedStage) {
			router.replace("/login");
			return;
		}

		if (shouldVerifySession && !user) {
			router.replace(`/login?redirectTo=${encodeURIComponent(requestedSetupPath)}`);
		}
	}, [
		isLoading,
		requestedAuthenticatedStage,
		requestedSetupPath,
		router,
		setupRequired,
		shouldVerifySession,
		user,
		userLoading,
	]);

	// Show loading while checking
	if (isLoading || (shouldVerifySession && userLoading)) {
		return <SetupLoading />;
	}

	// If setup is complete, don't render (will redirect)
	if (setupRequired?.required === false && (!requestedAuthenticatedStage || !user)) {
		return null;
	}

	return (
		<main className="flex min-h-screen items-center justify-center bg-background px-4">
			<SetupClient
				stage={
					requestedAuthenticatedStage && setupRequired?.required === false && user
						? requestedStage
						: "account"
				}
			/>
		</main>
	);
};

const SetupPage = () => (
	<Suspense fallback={<SetupLoading />}>
		<SetupPageContent />
	</Suspense>
);

export default SetupPage;
