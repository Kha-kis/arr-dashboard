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
import {
	DataFreshness,
	PremiumPageHeader,
	type PremiumTab,
	PremiumTabs,
} from "../../../components/layout";
import { Button } from "../../../components/ui";
import { usePulseQuery } from "../../../hooks/api/usePulse";
import { POLLING_STATS } from "../../../lib/polling-intervals";
import { NeedsAttentionPanel } from "../../dashboard/components/needs-attention-panel";

export type ConsoleTabId = "overview";

// The Automation tab registers here when the rule composer lands.
// PremiumTabs renders only when there is more than one tab: a lone tab is
// chrome without a choice, and shipping a dead "Automation" stub before
// the composer exists would violate the no-misleading-surfaces trust rule.
const CONSOLE_TABS: PremiumTab[] = [{ id: "overview", label: "Overview", icon: Gauge }];

export const ConsoleClient = () => {
	const [activeTab, setActiveTab] = useState<ConsoleTabId>("overview");

	// Same query key as NeedsAttentionPanel's internal hook — React Query
	// dedupes, so this adds no extra fetch; it only feeds the header's
	// freshness indicator and refresh action.
	const { refetch, dataUpdatedAt, isFetching, isError } = usePulseQuery({
		attentionOnly: true,
	});

	return (
		<>
			<PremiumPageHeader
				label="Operator Console"
				labelIcon={Gauge}
				title="Console"
				gradientTitle
				description="One view of every domain's health and what needs your attention — with one-click operator actions"
				actions={
					<div className="flex items-center gap-3">
						{/* Freshness of the attention feed — the only polled data on
						    this surface until the domain tiles land (console PR 3). */}
						{activeTab === "overview" && (
							<DataFreshness
								dataUpdatedAt={dataUpdatedAt}
								isFetching={isFetching}
								isError={isError}
								pollIntervalMs={POLLING_STATS}
							/>
						)}
						<Button
							variant="secondary"
							onClick={() => void refetch()}
							className="gap-2 border-border/50 bg-card/50 backdrop-blur-xs hover:bg-card/80"
						>
							<RefreshCw className="h-4 w-4" />
							Refresh
						</Button>
					</div>
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
					// PR 3 turns this into the two-column split:
					// grid lg:grid-cols-[2fr_1fr] — domain tiles left, feed right.
					<NeedsAttentionPanel />
				)}
			</div>
		</>
	);
};
