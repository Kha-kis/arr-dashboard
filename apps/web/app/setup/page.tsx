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
	const requestedServicesStage = searchParams.get("stage") === "services";
	const { data: setupRequired, isLoading } = useSetupRequired();
	const shouldVerifySession = setupRequired?.required === false && requestedServicesStage;
	const { data: user, isLoading: userLoading } = useCurrentUser(shouldVerifySession);

	useEffect(() => {
		if (isLoading || userLoading) return;

		if (setupRequired?.required === false && !requestedServicesStage) {
			router.replace("/login");
			return;
		}

		if (shouldVerifySession && !user) {
			router.replace("/login?redirectTo=%2Fsetup%3Fstage%3Dservices");
		}
	}, [
		isLoading,
		requestedServicesStage,
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
	if (setupRequired?.required === false && (!requestedServicesStage || !user)) {
		return null;
	}

	return (
		<main className="flex min-h-screen items-center justify-center bg-background px-4">
			<SetupClient
				stage={
					requestedServicesStage && setupRequired?.required === false && user
						? "services"
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
