"use client";

import type { Condition, CreateCleanupRule } from "@arr/shared";
import { CheckCheck, Combine, EyeOff, Sparkles, Timer } from "lucide-react";
import type { LucideIcon } from "lucide-react";
import { useThemeGradient } from "@/hooks/useThemeGradient";

// ============================================================================
// Template Definitions
// ============================================================================

type TemplateCategory = "cross-service" | "watch-activity";

const CATEGORY_LABELS: Record<TemplateCategory, string> = {
	"cross-service": "Cross-Service",
	"watch-activity": "Watch Activity",
};

export interface RuleTemplate {
	id: string;
	name: string;
	description: string;
	icon: LucideIcon;
	category: TemplateCategory;
	/** Services that must be configured for this template to be useful */
	requiredServices: Array<"plex" | "seerr" | "tautulli">;
	/** Builds a CreateCleanupRule with placeholder values the user can customize */
	buildRule: () => CreateCleanupRule;
}

export const RULE_TEMPLATES: RuleTemplate[] = [
	// ── Cross-Service ──────────────────────────────────────────────
	{
		id: "requested-and-watched",
		name: "Requested & Watched",
		description:
			"Flag items that a user both requested in Seerr and has already watched in Plex — safe candidates for cleanup.",
		icon: Combine,
		category: "cross-service",
		requiredServices: ["plex", "seerr"],
		buildRule: () => ({
			name: "Requested & Watched by Same User",
			enabled: true,
			priority: 0,
			ruleType: "composite" as const,
			parameters: {},
			action: "unmonitor" as const,
			operator: "AND" as const,
			conditions: [
				{
					ruleType: "seerr_requested_by",
					parameters: { userNames: [] },
				},
				{
					ruleType: "plex_watched_by",
					parameters: { operator: "includes_any", userNames: [] },
				},
			] satisfies Condition[],
			retentionMode: false,
		}),
	},
	{
		id: "requested-not-watched",
		name: "Requested but Not Watched",
		description:
			"Flag items that a user requested in Seerr but has never watched in Plex — identify forgotten requests.",
		icon: EyeOff,
		category: "cross-service",
		requiredServices: ["plex", "seerr"],
		buildRule: () => ({
			name: "Requested but Not Watched",
			enabled: true,
			priority: 0,
			ruleType: "composite" as const,
			parameters: {},
			action: "unmonitor" as const,
			operator: "AND" as const,
			conditions: [
				{
					ruleType: "seerr_requested_by",
					parameters: { userNames: [] },
				},
				{
					ruleType: "plex_watched_by",
					parameters: { operator: "excludes_all", userNames: [] },
				},
			] satisfies Condition[],
			retentionMode: false,
		}),
	},

	// ── Watch Activity ─────────────────────────────────────────────
	{
		id: "stale-unwatched",
		name: "Stale & Unwatched",
		description:
			"Score items by watch recency, play count, ratings, and size. High-scoring items are stale and candidates for cleanup.",
		icon: Timer,
		category: "watch-activity",
		requiredServices: ["plex"],
		buildRule: () => ({
			name: "Stale & Unwatched",
			enabled: true,
			priority: 0,
			ruleType: "staleness_score" as const,
			parameters: { operator: "greater_than", threshold: 75 },
			action: "unmonitor" as const,
			retentionMode: false,
		}),
	},
	{
		id: "finished-fully-watched",
		name: "Finished & Fully Watched",
		description:
			"Flag ended series where 90%+ of episodes have been watched — completed shows ready for cleanup.",
		icon: CheckCheck,
		category: "watch-activity",
		requiredServices: ["plex"],
		buildRule: () => ({
			name: "Finished & Fully Watched Series",
			enabled: true,
			priority: 0,
			ruleType: "composite" as const,
			parameters: {},
			action: "unmonitor" as const,
			operator: "AND" as const,
			serviceFilter: ["sonarr"],
			conditions: [
				{
					ruleType: "status",
					parameters: { statuses: ["ended"] },
				},
				{
					ruleType: "plex_episode_completion",
					parameters: { operator: "greater_than", percentage: 90 },
				},
			] satisfies Condition[],
			retentionMode: false,
		}),
	},
];

// ============================================================================
// Template Picker UI
// ============================================================================

interface CleanupRuleTemplatesProps {
	hasPlex: boolean;
	hasSeerr: boolean;
	hasTautulli: boolean;
	onSelectTemplate: (rule: CreateCleanupRule) => void;
}

export function CleanupRuleTemplates({
	hasPlex,
	hasSeerr,
	hasTautulli,
	onSelectTemplate,
}: CleanupRuleTemplatesProps) {
	const { gradient } = useThemeGradient();

	const serviceAvailable = (service: "plex" | "seerr" | "tautulli") => {
		if (service === "plex") return hasPlex;
		if (service === "seerr") return hasSeerr;
		if (service === "tautulli") return hasTautulli;
		return false;
	};

	const availableTemplates = RULE_TEMPLATES.filter((t) =>
		t.requiredServices.every(serviceAvailable),
	);

	if (availableTemplates.length === 0) return null;

	// Group available templates by category, preserving definition order
	const categories: Array<{ key: TemplateCategory; label: string; templates: RuleTemplate[] }> =
		[];
	for (const tpl of availableTemplates) {
		let group = categories.find((c) => c.key === tpl.category);
		if (!group) {
			group = { key: tpl.category, label: CATEGORY_LABELS[tpl.category], templates: [] };
			categories.push(group);
		}
		group.templates.push(tpl);
	}

	return (
		<div
			className="relative rounded-xl overflow-hidden"
			style={{ border: `1px solid ${gradient.from}10` }}
		>
			<div
				className="absolute inset-0 pointer-events-none"
				style={{ background: `linear-gradient(135deg, ${gradient.from}04, transparent 60%)` }}
			/>
			<div
				className="absolute left-0 top-0 bottom-0 w-[3px]"
				style={{ background: `linear-gradient(180deg, ${gradient.from}, ${gradient.fromLight})` }}
			/>
			<div className="relative p-5">
				<div className="flex items-center gap-2 mb-1">
					<span
						className="inline-flex items-center gap-1 rounded-md px-1.5 py-0.5 text-[10px] font-semibold uppercase tracking-wider"
						style={{ backgroundColor: `${gradient.from}12`, color: gradient.from }}
					>
						<Sparkles className="h-2.5 w-2.5" />
						Templates
					</span>
				</div>
				<p className="text-xs text-muted-foreground mb-4">
					Rule shortcuts. Each template creates an editable rule that you can customize
					after creation.
				</p>

				<div className="space-y-4">
					{categories.map((cat) => (
						<div key={cat.key}>
							<h4 className="text-[11px] font-medium uppercase tracking-wider text-muted-foreground/70 mb-2">
								{cat.label}
							</h4>
							<div className="grid gap-3 sm:grid-cols-2">
								{cat.templates.map((template) => {
									const Icon = template.icon;
									return (
										<button
											key={template.id}
											type="button"
											onClick={() => onSelectTemplate(template.buildRule())}
											className="group text-left rounded-lg border border-border/30 bg-card/20 p-4 hover:border-border/60 hover:bg-card/40 transition-all duration-200"
										>
											<div className="flex items-center gap-2 mb-2">
												<div
													className="rounded-md p-1.5"
													style={{ backgroundColor: `${gradient.from}12` }}
												>
													<Icon className="h-3.5 w-3.5" style={{ color: gradient.from }} />
												</div>
												<span className="text-sm font-medium">{template.name}</span>
											</div>
											<p className="text-xs text-muted-foreground leading-relaxed">
												{template.description}
											</p>
											<span
												className="mt-3 inline-block text-xs font-medium opacity-0 group-hover:opacity-100 transition-opacity"
												style={{ color: gradient.from }}
											>
												Use template &rarr;
											</span>
										</button>
									);
								})}
							</div>
						</div>
					))}
				</div>
			</div>
		</div>
	);
}
