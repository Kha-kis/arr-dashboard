"use client";

import type { CombinedDiskStats } from "@arr/shared";
import { HardDrive } from "lucide-react";
import Link from "next/link";
import { GlassmorphicCard } from "../../../components/layout";
import { useThemeGradient } from "../../../hooks/useThemeGradient";
import { formatBytes } from "../../../lib/format-utils";
import { SEMANTIC_COLORS } from "../../../lib/theme-gradients";

interface DiskUsageWidgetProps {
	combinedDisk?: CombinedDiskStats;
	animationDelay?: number;
}

function getUsageColor(
	percent: number,
	themeFrom: string,
): {
	barColor: string;
	barGlow: string;
	textColor: string;
} {
	if (percent >= 90) {
		return {
			barColor: `linear-gradient(90deg, ${SEMANTIC_COLORS.error.text}, #f87171)`,
			barGlow: SEMANTIC_COLORS.error.glow,
			textColor: SEMANTIC_COLORS.error.text,
		};
	}
	if (percent >= 75) {
		return {
			barColor: `linear-gradient(90deg, ${SEMANTIC_COLORS.warning.text}, #fbbf24)`,
			barGlow: SEMANTIC_COLORS.warning.glow,
			textColor: SEMANTIC_COLORS.warning.text,
		};
	}
	return {
		barColor: `linear-gradient(90deg, ${themeFrom}, ${themeFrom}cc)`,
		barGlow: `${themeFrom}40`,
		textColor: themeFrom,
	};
}

export const DiskUsageWidget = ({ combinedDisk, animationDelay = 0 }: DiskUsageWidgetProps) => {
	const { gradient } = useThemeGradient();

	if (!combinedDisk) return null;

	const { diskTotal, diskFree, diskUsed, diskUsagePercent } = combinedDisk;
	const percent = Math.round(diskUsagePercent);
	const usage = getUsageColor(percent, gradient.from);

	return (
		<div
			className="animate-in fade-in slide-in-from-bottom-4 duration-500"
			style={{ animationDelay: `${animationDelay}ms`, animationFillMode: "backwards" }}
		>
			<Link href="/statistics" className="block">
				<GlassmorphicCard padding="none" className="group transition-all hover:border-border/80">
					{/* Accent line */}
					<div
						className="h-0.5 w-full rounded-t-xl"
						style={{
							background: `linear-gradient(90deg, ${gradient.from}, ${gradient.to})`,
						}}
					/>

					<div className="p-4 space-y-3">
						{/* Header row */}
						<div className="flex items-center justify-between">
							<div className="flex items-center gap-2">
								<div
									className="flex h-8 w-8 items-center justify-center rounded-lg"
									style={{
										background: `linear-gradient(135deg, ${gradient.from}20, ${gradient.to}20)`,
										border: `1px solid ${gradient.from}30`,
									}}
								>
									<HardDrive className="h-4 w-4" style={{ color: gradient.from }} />
								</div>
								<div>
									<h3 className="text-sm font-semibold text-foreground">Storage</h3>
									<p className="text-xs text-muted-foreground">
										{formatBytes(diskFree)} free of {formatBytes(diskTotal)}
									</p>
								</div>
							</div>
							<span className="text-lg font-bold tabular-nums" style={{ color: usage.textColor }}>
								{percent}%
							</span>
						</div>

						{/* Usage bar */}
						<div className="relative h-2 w-full rounded-full bg-muted/40 overflow-hidden">
							<div
								className="absolute inset-y-0 left-0 rounded-full transition-all duration-700 ease-out"
								style={{
									width: `${percent}%`,
									background: usage.barColor,
									boxShadow: `0 0 12px ${usage.barGlow}`,
								}}
							/>
						</div>

						{/* Stats row */}
						<div className="flex items-center justify-between text-xs text-muted-foreground">
							<span>
								<span className="font-medium text-foreground">{formatBytes(diskUsed)}</span> used
							</span>
							<span>
								<span className="font-medium text-foreground">{formatBytes(diskFree)}</span> free
							</span>
						</div>
					</div>
				</GlassmorphicCard>
			</Link>
		</div>
	);
};
