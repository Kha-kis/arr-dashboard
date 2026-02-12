"use client";

import { useState } from "react";
import { GlassmorphicCard } from "../../../components/layout";
import { useThemeGradient } from "../../../hooks/useThemeGradient";
import { BackupEncryptionSection } from "./backup-encryption-section";
import { BackupScheduleSection } from "./backup-schedule-section";
import { BackupCreateCard } from "./backup-create-card";
import { BackupRestoreCard } from "./backup-restore-card";
import { BackupListSection } from "./backup-list-section";

export const BackupTab = () => {
	const { gradient: themeGradient } = useThemeGradient();
	const [isRestarting, setIsRestarting] = useState(false);

	const pollForServerRestart = () => {
		const maxAttempts = 30;
		let attempts = 0;

		const checkServer = async (): Promise<void> => {
			attempts++;
			try {
				const healthResponse = await fetch("/auth/setup-required");
				if (healthResponse.ok) {
					window.location.href = "/login";
					return;
				}
			} catch (error) {
				if (attempts === maxAttempts) {
					console.error("Server health check failed after maximum attempts:", error);
				}
			}
			if (attempts < maxAttempts) {
				setTimeout(checkServer, 1000);
			} else {
				window.location.href = "/login";
			}
		};

		setTimeout(checkServer, 2000);
	};

	const handleRestoreComplete = (willRestart: boolean) => {
		if (willRestart) {
			setIsRestarting(true);
			pollForServerRestart();
		}
	};

	return (
		<div className="space-y-8">
			<BackupEncryptionSection />
			<BackupScheduleSection />
			<div className="grid gap-6 lg:grid-cols-2">
				<BackupCreateCard />
				<BackupRestoreCard onRestoreComplete={handleRestoreComplete} />
			</div>
			<BackupListSection onRestoreComplete={handleRestoreComplete} />

			{/* Server Restarting Modal */}
			{isRestarting && (
				<div
					className="fixed inset-0 z-modal flex items-center justify-center bg-black/80 backdrop-blur-xs"
					role="dialog"
					aria-modal="true"
					aria-labelledby="server-restarting-title"
				>
					<GlassmorphicCard padding="lg" className="w-full max-w-md m-4">
						<div className="flex flex-col items-center text-center space-y-4 py-4">
							<div
								className="animate-spin rounded-full h-12 w-12 border-b-2"
								style={{ borderColor: themeGradient.from }}
							/>
							<div>
								<h3 id="server-restarting-title" className="text-lg font-semibold mb-2 text-foreground">Server Restarting</h3>
								<p className="text-sm text-muted-foreground">
									Backup restored successfully. The server is restarting...
								</p>
								<p className="text-sm text-muted-foreground mt-2">
									You will be redirected to login automatically.
								</p>
							</div>
						</div>
					</GlassmorphicCard>
				</div>
			)}
		</div>
	);
};
