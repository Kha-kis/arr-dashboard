"use client";

import { useEffect } from "react";
import { useRouter } from "next/navigation";
import { useSetupRequired } from "../../src/hooks/api/useAuth";
import { SetupClient } from "../../src/features/setup/components/setup-client";
import { Skeleton } from "../../src/components/ui";

const SetupPage = () => {
	const router = useRouter();
	const { data: setupRequired, isLoading } = useSetupRequired();

	useEffect(() => {
		// If setup is complete, redirect to login
		if (!isLoading && setupRequired?.required === false) {
			router.replace("/login");
		}
	}, [isLoading, setupRequired, router]);

	// Show loading while checking
	if (isLoading) {
		return (
			<main className="flex min-h-screen items-center justify-center bg-background px-4">
				<Skeleton className="h-10 w-10 rounded-full" />
			</main>
		);
	}

	// If setup is complete, don't render (will redirect)
	if (setupRequired?.required === false) {
		return null;
	}

	return (
		<main className="flex min-h-screen items-center justify-center bg-background px-4">
			<SetupClient />
		</main>
	);
};

export default SetupPage;
