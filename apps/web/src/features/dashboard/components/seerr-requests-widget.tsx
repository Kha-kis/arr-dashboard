"use client";

import Link from "next/link";
import { Inbox, ChevronRight, Clock, Check, X } from "lucide-react";
import { GlassmorphicCard } from "../../../components/layout";
import { useSeerrRequestCount } from "../../../hooks/api/useSeerr";
import { SERVICE_GRADIENTS, SEMANTIC_COLORS } from "../../../lib/theme-gradients";

interface SeerrRequestsWidgetProps {
	instanceId: string;
	animationDelay?: number;
}

const seerrGradient = SERVICE_GRADIENTS.seerr;

export const SeerrRequestsWidget = ({
	instanceId,
	animationDelay = 0,
}: SeerrRequestsWidgetProps) => {
	const { data: counts, isError } = useSeerrRequestCount(instanceId);

	if (isError || !counts) return null;

	const stats = [
		{ icon: Clock, label: "Pending", value: counts.pending, color: SEMANTIC_COLORS.warning.text },
		{ icon: Check, label: "Approved", value: counts.approved, color: SEMANTIC_COLORS.success.text },
		{ icon: X, label: "Declined", value: counts.declined, color: SEMANTIC_COLORS.error.text },
	];

	return (
		<div
			className="animate-in fade-in slide-in-from-bottom-4 duration-500"
			style={{ animationDelay: `${animationDelay}ms`, animationFillMode: "backwards" }}
		>
			<Link href="/requests" className="block">
				<GlassmorphicCard padding="none" className="group transition-all hover:border-border/80">
					{/* Accent line */}
					<div
						className="h-0.5 w-full rounded-t-xl"
						style={{
							background: `linear-gradient(90deg, ${seerrGradient.from}, ${seerrGradient.to})`,
						}}
					/>

					<div className="p-4">
						<div className="flex items-center justify-between">
							<div className="flex items-center gap-2">
								<div
									className="flex h-8 w-8 items-center justify-center rounded-lg"
									style={{
										background: `linear-gradient(135deg, ${seerrGradient.from}20, ${seerrGradient.to}20)`,
										border: `1px solid ${seerrGradient.from}30`,
									}}
								>
									<Inbox className="h-4 w-4" style={{ color: seerrGradient.from }} />
								</div>
								<div>
									<h3 className="text-sm font-semibold text-foreground">Seerr Requests</h3>
									<p className="text-xs text-muted-foreground">
										{counts.total} total request{counts.total !== 1 ? "s" : ""}
									</p>
								</div>
							</div>
							<ChevronRight className="h-4 w-4 text-muted-foreground transition-transform group-hover:translate-x-0.5" />
						</div>

						{/* Mini stats row */}
						<div className="mt-3 flex items-center gap-4">
							{stats.map((stat) => (
								<div key={stat.label} className="flex items-center gap-1.5">
									<stat.icon className="h-3 w-3" style={{ color: stat.color }} />
									<span className="text-xs font-medium text-foreground">{stat.value}</span>
									<span className="text-[10px] text-muted-foreground">{stat.label}</span>
								</div>
							))}
						</div>
					</div>
				</GlassmorphicCard>
			</Link>
		</div>
	);
};
