"use client";

import type { LucideIcon } from "lucide-react";
import { Button } from "../../../components/ui/button";
import type { ServiceGradient } from "../../../lib/theme-gradients";

export interface ServiceQuickStat {
	label: string;
	value: string | number;
	/** Highlight this stat with the service color */
	highlight?: boolean;
}

interface ServiceQuickCardProps {
	name: string;
	icon: LucideIcon;
	gradient: ServiceGradient;
	stats: ServiceQuickStat[];
	onViewDetails: () => void;
}

const integer = new Intl.NumberFormat();

const formatStatValue = (value: string | number) =>
	typeof value === "number" ? integer.format(value) : value;

export const ServiceQuickCard = ({
	name,
	icon: Icon,
	gradient,
	stats,
	onViewDetails,
}: ServiceQuickCardProps) => {
	return (
		<div className="group relative rounded-2xl border border-border/50 bg-card/30 backdrop-blur-xs p-6 overflow-hidden transition-all duration-300 hover:border-border">
			<div
				className="absolute inset-0 opacity-0 group-hover:opacity-20 transition-opacity duration-500"
				style={{ background: `radial-gradient(circle at 50% 0%, ${gradient.glow}, transparent 70%)` }}
			/>
			<div className="relative">
				<div className="flex items-center gap-3 mb-4">
					<div
						className="flex h-10 w-10 items-center justify-center rounded-xl"
						style={{
							background: `linear-gradient(135deg, ${gradient.from}, ${gradient.to})`,
							boxShadow: `0 4px 12px -4px ${gradient.glow}`,
						}}
					>
						<Icon className="h-5 w-5 text-white" />
					</div>
					<h3 className="text-lg font-semibold">{name}</h3>
				</div>
				<div className="space-y-3">
					{stats.map((stat) => (
						<div key={stat.label} className="flex justify-between text-sm">
							<span className="text-muted-foreground">{stat.label}</span>
							<span
								className="font-medium"
								style={stat.highlight ? { color: gradient.from } : undefined}
							>
								{formatStatValue(stat.value)}
							</span>
						</div>
					))}
				</div>
				<Button
					variant="ghost"
					size="sm"
					className="w-full mt-4 border border-border/50"
					onClick={onViewDetails}
				>
					View Details
				</Button>
			</div>
		</div>
	);
};
