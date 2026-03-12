"use client";

import { ArrowRight, Globe, Search, Server, Settings, Wifi } from "lucide-react";
import Link from "next/link";
import { useThemeGradient } from "../../../hooks/useThemeGradient";
import { SERVICE_GRADIENTS } from "../../../lib/theme-gradients";

// Use centralized Prowlarr color
const PROWLARR_COLOR = SERVICE_GRADIENTS.prowlarr.from;

/**
 * Floating background orb for visual depth
 */
const FloatingOrb = ({
	color,
	size,
	top,
	left,
	delay,
}: {
	color: string;
	size: number;
	top: string;
	left: string;
	delay: string;
}) => (
	<div
		className="absolute rounded-full opacity-[0.06] animate-pulse pointer-events-none"
		style={{
			width: size,
			height: size,
			top,
			left,
			backgroundColor: color,
			filter: `blur(${size / 3}px)`,
			animationDuration: "4s",
			animationDelay: delay,
		}}
	/>
);

/**
 * Premium Empty Indexers Card
 *
 * Displayed when no Prowlarr instances are configured with:
 * - Floating orb background for visual depth
 * - Prowlarr-branded icon cluster
 * - CTA to settings page
 */
export const EmptyIndexersCard = () => {
	const { gradient: themeGradient } = useThemeGradient();

	return (
		<div className="relative rounded-2xl border border-dashed border-border/50 bg-card/20 backdrop-blur-xs p-12 text-center animate-in fade-in slide-in-from-bottom-4 duration-500 overflow-hidden">
			{/* Background orbs */}
			<FloatingOrb color={PROWLARR_COLOR} size={120} top="-20px" left="10%" delay="0s" />
			<FloatingOrb color={themeGradient.from} size={80} top="60%" left="75%" delay="1.5s" />
			<FloatingOrb color={PROWLARR_COLOR} size={60} top="40%" left="5%" delay="0.8s" />

			{/* Icon cluster — overlapping icons for visual interest */}
			<div className="relative mx-auto mb-6 flex items-center justify-center h-20 w-36">
				<div
					className="absolute flex h-14 w-14 items-center justify-center rounded-2xl -rotate-6"
					style={{
						background: `linear-gradient(135deg, ${PROWLARR_COLOR}15, ${PROWLARR_COLOR}08)`,
						border: `1px solid ${PROWLARR_COLOR}25`,
						left: "10%",
					}}
				>
					<Globe className="h-6 w-6" style={{ color: `${PROWLARR_COLOR}80` }} />
				</div>
				<div
					className="absolute flex h-16 w-16 items-center justify-center rounded-2xl z-10"
					style={{
						background: `linear-gradient(135deg, ${PROWLARR_COLOR}25, ${PROWLARR_COLOR}12)`,
						border: `1px solid ${PROWLARR_COLOR}35`,
						boxShadow: `0 8px 24px -8px ${PROWLARR_COLOR}30`,
					}}
				>
					<Server className="h-8 w-8" style={{ color: PROWLARR_COLOR }} />
				</div>
				<div
					className="absolute flex h-14 w-14 items-center justify-center rounded-2xl rotate-6"
					style={{
						background: `linear-gradient(135deg, ${PROWLARR_COLOR}15, ${PROWLARR_COLOR}08)`,
						border: `1px solid ${PROWLARR_COLOR}25`,
						right: "10%",
					}}
				>
					<Search className="h-6 w-6" style={{ color: `${PROWLARR_COLOR}80` }} />
				</div>
			</div>

			{/* Title */}
			<h2 className="text-xl font-bold mb-2" style={{ color: PROWLARR_COLOR }}>
				No Prowlarr Instances Configured
			</h2>

			{/* Description */}
			<p className="text-sm text-muted-foreground max-w-md mx-auto mb-8">
				Add a Prowlarr service in Settings to manage indexers from this dashboard. Once a Prowlarr
				instance is enabled, its indexers will appear here automatically.
			</p>

			{/* Feature hints */}
			<div className="flex flex-wrap items-center justify-center gap-4 mb-8 text-xs text-muted-foreground/60">
				<span className="inline-flex items-center gap-1.5">
					<Search className="h-3 w-3" />
					Search indexers
				</span>
				<span className="text-muted-foreground/30">&middot;</span>
				<span className="inline-flex items-center gap-1.5">
					<Wifi className="h-3 w-3" />
					Test connectivity
				</span>
				<span className="text-muted-foreground/30">&middot;</span>
				<span className="inline-flex items-center gap-1.5">
					<Settings className="h-3 w-3" />
					Edit configuration
				</span>
			</div>

			{/* CTA Button */}
			<Link
				href="/settings"
				className="inline-flex items-center gap-2 rounded-xl px-5 py-2.5 text-sm font-medium transition-all duration-200 hover:opacity-90 hover:translate-y-[-1px] hover:shadow-lg"
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
