"use client";

/**
 * Getting Started Banner
 *
 * Shown on the Settings > Services tab when no services are configured.
 * Guides users through adding services in a recommended order,
 * highlighting the OAuth setup helpers for Plex and Seerr.
 */

import type { ServiceInstanceSummary } from "@arr/shared";
import { ArrowRight, Server } from "lucide-react";
import { useIncognitoMode } from "../../../lib/incognito";
import { useThemeGradient } from "../../../hooks/useThemeGradient";
import { getServiceGradient } from "../../../lib/theme-gradients";
import type { ServiceType } from "../lib/settings-constants";

interface GettingStartedBannerProps {
	services: ServiceInstanceSummary[];
	onSelectService: (service: ServiceType) => void;
}

interface SetupStep {
	service: ServiceType;
	label: string;
	description: string;
	hasHelper: boolean;
}

const SETUP_STEPS: SetupStep[] = [
	{
		service: "plex",
		label: "Plex",
		description: "Connect with Plex sign-in to auto-discover your server",
		hasHelper: true,
	},
	{
		service: "sonarr",
		label: "Sonarr",
		description: "TV show management — API key from Settings > General",
		hasHelper: false,
	},
	{
		service: "radarr",
		label: "Radarr",
		description: "Movie management — API key from Settings > General",
		hasHelper: false,
	},
	{
		service: "seerr",
		label: "Seerr",
		description: "Media requests — sign in with Plex to auto-detect API key",
		hasHelper: true,
	},
	{
		service: "tautulli",
		label: "Tautulli",
		description: "Plex analytics — API key from Settings > Web Interface",
		hasHelper: false,
	},
	{
		service: "jellyfin",
		label: "Jellyfin",
		description: "Media server — API key from Dashboard > API Keys",
		hasHelper: false,
	},
	{
		service: "prowlarr",
		label: "Prowlarr",
		description: "Indexer management — API key from Settings > General",
		hasHelper: false,
	},
];

export const GettingStartedBanner = ({ services, onSelectService }: GettingStartedBannerProps) => {
	const { gradient: themeGradient } = useThemeGradient();
	const [isIncognito] = useIncognitoMode();
	const configuredTypes = new Set(services.map((s) => s.service.toLowerCase()));

	// Don't show if user has 3+ services — they know what they're doing
	if (services.length >= 3) return null;

	const stepsToShow = SETUP_STEPS.filter((step) => !configuredTypes.has(step.service));
	if (stepsToShow.length === 0) return null;

	return (
		<div
			className="mb-6 rounded-xl border p-5"
			style={{
				borderColor: `${themeGradient.from}30`,
				background: `linear-gradient(135deg, ${themeGradient.from}05, ${themeGradient.to}05)`,
			}}
		>
			<div className="mb-4 flex items-center gap-3">
				<div
					className="flex h-8 w-8 items-center justify-center rounded-lg"
					style={{ backgroundColor: `${themeGradient.from}15` }}
				>
					<Server className="h-4 w-4" style={{ color: themeGradient.from }} />
				</div>
				<div>
					<h3 className="text-sm font-semibold">
						{services.length === 0 ? "Get started" : "Add more services"}
					</h3>
					<p className="text-xs text-muted-foreground">
						{services.length === 0
							? "Connect your media services to get started."
							: isIncognito
								? "Add more services to unlock full features."
								: `${services.length} configured — add more to unlock full features.`}
					</p>
				</div>
			</div>

			<div className="grid gap-2 sm:gap-3 sm:grid-cols-2">
				{stepsToShow.slice(0, 4).map((step) => {
					const gradient = getServiceGradient(step.service);
					return (
						<button
							key={step.service}
							type="button"
							onClick={() => onSelectService(step.service)}
							className="group flex min-h-[44px] items-center gap-2 rounded-lg border border-border/50 bg-card/30 px-3 py-2.5 text-left transition-all duration-200 hover:border-border hover:bg-card/60 sm:gap-3"
						>
							<div
								className="flex h-6 w-6 shrink-0 items-center justify-center rounded"
								style={{ backgroundColor: `${gradient.from}15` }}
							>
								<span className="text-[10px] font-bold uppercase" style={{ color: gradient.from }}>
									{step.label.charAt(0)}
								</span>
							</div>
							<div className="min-w-0 flex-1">
								<div className="flex items-center gap-1.5">
									<span className="text-xs font-medium">{step.label}</span>
									{step.hasHelper && (
										<span
											className="rounded px-1 py-0.5 text-[9px] font-medium"
											style={{
												backgroundColor: `${gradient.from}15`,
												color: gradient.from,
											}}
										>
											Auto-setup
										</span>
									)}
								</div>
								<p className="truncate text-[10px] text-muted-foreground">{step.description}</p>
							</div>
							<ArrowRight className="h-3 w-3 shrink-0 text-muted-foreground opacity-0 transition-opacity group-hover:opacity-100" />
						</button>
					);
				})}
			</div>

			{services.length > 0 && stepsToShow.length > 4 && (
				<p className="mt-2 text-center text-[10px] text-muted-foreground">
					+{stepsToShow.length - 4} more available
				</p>
			)}
		</div>
	);
};
