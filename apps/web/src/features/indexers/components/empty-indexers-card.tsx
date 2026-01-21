"use client";

import { Server, Settings, ArrowRight } from "lucide-react";
import { useThemeGradient } from "../../../hooks/useThemeGradient";
import { SERVICE_GRADIENTS } from "../../../lib/theme-gradients";
import Link from "next/link";

// Use centralized Prowlarr color
const PROWLARR_COLOR = SERVICE_GRADIENTS.prowlarr.from;

/**
 * Premium Empty Indexers Card
 *
 * Displayed when no Prowlarr instances are configured with:
 * - Glassmorphic card styling
 * - Prowlarr-branded icon
 * - CTA to settings page
 */
export const EmptyIndexersCard = () => {
	const { gradient: themeGradient } = useThemeGradient();

	return (
		<div className="rounded-2xl border border-dashed border-border/50 bg-card/20 backdrop-blur-xs p-12 text-center animate-in fade-in slide-in-from-bottom-4 duration-500">
			{/* Icon */}
			<div
				className="mx-auto mb-6 flex h-16 w-16 items-center justify-center rounded-2xl"
				style={{
					background: `linear-gradient(135deg, ${PROWLARR_COLOR}20, ${PROWLARR_COLOR}10)`,
					border: `1px solid ${PROWLARR_COLOR}30`,
				}}
			>
				<Server className="h-8 w-8" style={{ color: PROWLARR_COLOR }} />
			</div>

			{/* Title */}
			<h2
				className="text-xl font-bold mb-2"
				style={{ color: PROWLARR_COLOR }}
			>
				No Prowlarr Instances Configured
			</h2>

			{/* Description */}
			<p className="text-sm text-muted-foreground max-w-md mx-auto mb-6">
				Add a Prowlarr service in Settings to manage indexers from this dashboard.
				Once a Prowlarr instance is enabled, its indexers will appear here automatically.
			</p>

			{/* CTA Button */}
			<Link
				href="/settings"
				className="inline-flex items-center gap-2 rounded-xl px-5 py-2.5 text-sm font-medium transition-all duration-200 hover:opacity-90"
				style={{
					background: `linear-gradient(135deg, ${themeGradient.from}, ${themeGradient.to})`,
					boxShadow: `0 4px 12px -4px ${themeGradient.glow}`,
				}}
			>
				<Settings className="h-4 w-4" />
				Go to Settings
				<ArrowRight className="h-4 w-4" />
			</Link>
		</div>
	);
};
