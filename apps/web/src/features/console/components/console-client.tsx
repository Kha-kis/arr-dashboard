"use client";

/**
 * Operator Console — the 3.0 flagship surface (charter §2.1).
 *
 * One canonical operator view: per-domain health + freshness +
 * next-scheduled-action tiles, the Pulse needs-attention rollup as the
 * action feed, and (later) the embedded rule composer for the Unified
 * Automation Engine.
 *
 * Layout (ratified with the charter, refined 2026-06-10): PremiumTabs as
 * primary navigation; the Overview tab becomes a two-column split (domain
 * tiles left, attention feed right) once the tiles land. Console arc:
 *   PR 2 (this) — shell + live attention feed
 *   PR 3 — per-domain tiles (Overview becomes the split)
 *   PR 4 — Pulse rollup refinements / operator actions
 *   PR 6 — rule composer (registers the Automation tab)
 *
 * The attention feed is the SAME component the dashboard renders
 * (NeedsAttentionPanel) — charter §2.1 names the rollup as the console's
 * action feed, and sharing the component keeps its trust rules (honest
 * error state, incognito anonymization, no client-side re-classification)
 * in one place instead of forking them.
 */

import { Gauge, RefreshCw } from "lucide-react";
import { useState } from "react";
import { PremiumPageHeader, type PremiumTab, PremiumTabs } from "../../../components/layout";
import { Button } from "../../../components/ui";
import { usePulseQuery } from "../../../hooks/api/usePulse";
import { useSystemJobs } from "../../../hooks/api/useSystem";
import { NeedsAttentionPanel } from "../../dashboard/components/needs-attention-panel";
import { DomainTileGrid } from "./domain-tile-grid";

export type ConsoleTabId = "overview";

// The Automation tab registers here when the rule composer lands.
// PremiumTabs renders only when there is more than one tab: a lone tab is
// chrome without a choice, and shipping a dead "Automation" stub before
// the composer exists would violate the no-misleading-surfaces trust rule.
const CONSOLE_TABS: PremiumTab[] = [{ id: "overview", label: "Overview", icon: Gauge }];

export const ConsoleClient = () => {
	const [activeTab, setActiveTab] = useState<ConsoleTabId>("overview");

	// Same query keys as the panels' internal hooks — React Query dedupes,
	// so these add no extra fetches; they only feed the header's Refresh
	// action. No header DataFreshness: the Overview is now a multi-feed
	// surface (jobs + attention), and a single indicator tied to one query
	// would under-report — the B4 sweep's multi-feed exclusion rule.
	const attentionQuery = usePulseQuery({ attentionOnly: true });
	const jobsQuery = useSystemJobs();
	const refreshAll = () => {
		void attentionQuery.refetch();
		void jobsQuery.refetch();
	};

	return (
		<>
			<PremiumPageHeader
				label="Operator Console"
				labelIcon={Gauge}
				title="Console"
				gradientTitle
				description="One view of every domain's health and what needs your attention — with one-click operator actions"
				actions={
					<Button
						variant="secondary"
						onClick={refreshAll}
						className="gap-2 border-border/50 bg-card/50 backdrop-blur-xs hover:bg-card/80"
					>
						<RefreshCw className="h-4 w-4" />
						Refresh
					</Button>
				}
			/>

			{CONSOLE_TABS.length > 1 && (
				<div
					className="animate-in fade-in slide-in-from-bottom-4 duration-500"
					style={{ animationDelay: "100ms", animationFillMode: "backwards" }}
				>
					<PremiumTabs
						tabs={CONSOLE_TABS}
						activeTab={activeTab}
						onTabChange={(tabId) => setActiveTab(tabId as ConsoleTabId)}
					/>
				</div>
			)}

			<div
				className="animate-in fade-in slide-in-from-bottom-4 duration-500"
				style={{ animationDelay: "200ms", animationFillMode: "backwards" }}
			>
				{activeTab === "overview" && (
					// The ratified Overview split: domain tiles (status at a
					// glance) left, the attention feed (what needs me) right.
					// Stacks on smaller screens, tiles first.
					<div className="grid grid-cols-1 gap-6 lg:grid-cols-[minmax(0,3fr)_minmax(0,2fr)]">
						<DomainTileGrid />
						<NeedsAttentionPanel />
					</div>
				)}
			</div>
		</>
	);
};
