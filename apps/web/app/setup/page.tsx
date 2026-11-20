"use client";

import { useRouter } from "next/navigation";
import { useEffect } from "react";
import { Skeleton } from "../../src/components/ui";
import { Button } from "../../src/components/ui/button";
import { SetupClient } from "../../src/features/setup/components/setup-client";
import { useSetupRequired } from "../../src/hooks/api/useAuth";

const SetupPage = () => {
	const router = useRouter();
	const { data: setupRequired, isLoading, isFetching, isSuccess, refetch } = useSetupRequired();
	const eligibilityAvailable = isSuccess && typeof setupRequired?.required === "boolean";

	useEffect(() => {
		// If setup is complete, redirect to login
		if (!isFetching && eligibilityAvailable && setupRequired?.required === false) {
			router.replace("/login");
		}
	}, [isFetching, eligibilityAvailable, setupRequired?.required, router]);

	// Show loading while checking
	if (isLoading || isFetching) {
		return (
			<main className="flex min-h-screen items-center justify-center bg-background px-4">
				<Skeleton className="h-10 w-10 rounded-full" />
			</main>
		);
	}

	if (!eligibilityAvailable) {
		return (
			<main className="flex min-h-screen items-center justify-center bg-background px-4">
				<div className="space-y-4 text-center">
					<p role="alert" className="text-sm text-muted-foreground">
						Setup is unavailable. Unable to verify whether setup is required.
					</p>
					<Button onClick={() => void refetch()}>Retry</Button>
				</div>
			</main>
		);
	}

	// If setup is complete, don't render (will redirect)
	if (setupRequired?.required === false) {
		return null;
	}

	return (
		<main className="flex min-h-screen items-center justify-center bg-background px-4">
			<SetupClient passwordPolicy={setupRequired?.passwordPolicy ?? "strict"} />
		</main>
	);
};

export default SetupPage;
