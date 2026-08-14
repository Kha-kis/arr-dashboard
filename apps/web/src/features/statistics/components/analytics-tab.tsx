"use client";

import type { AnalyticsProvider } from "@arr/shared";
import { Settings2 } from "lucide-react";
import Link from "next/link";
import { Button } from "../../../components/ui";
import {
	useAnalyticsProviderSelection,
	useUpdateAnalyticsProviderSelection,
} from "../../../hooks/api/useSystem";
import { TautulliTab } from "./tautulli-tab";
import { TracearrTab } from "./tracearr-tab";

const providerLabel = (provider: AnalyticsProvider) =>
	provider === "tracearr" ? "Tracearr" : "Tautulli";

export function AnalyticsTab() {
	const { data: selection, isLoading } = useAnalyticsProviderSelection();
	const updateSelection = useUpdateAnalyticsProviderSelection();

	if (isLoading || !selection) {
		return <div className="h-56 animate-pulse rounded-xl border border-border/50 bg-card/30" />;
	}

	if (selection.status !== "configured") {
		const alternative: AnalyticsProvider =
			selection.selected === "tracearr" ? "tautulli" : "tracearr";
		const alternativeAvailable = selection.families[alternative].enabledCount > 0;
		const neitherConfigured =
			selection.families.tracearr.configuredCount === 0 &&
			selection.families.tautulli.configuredCount === 0;
		return (
			<div className="rounded-xl border border-warning/50 bg-warning/10 p-6" role="status">
				<div className="flex items-start gap-3">
					<Settings2 className="mt-0.5 h-5 w-5 text-warning" />
					<div className="space-y-3">
						<div>
							<h2 className="font-semibold">
								{neitherConfigured
									? "No historical analytics provider is configured yet."
									: `${providerLabel(selection.selected)} is selected but unavailable`}
							</h2>
							<p className="mt-1 text-sm text-muted-foreground">
								Configure the selected provider to view its historical analytics. arr-dashboard will
								not render another provider automatically.
							</p>
						</div>
						<div className="flex flex-wrap gap-2">
							<Button asChild variant="secondary">
								<Link href="/settings/services#analytics-provider">
									Configure selected provider
								</Link>
							</Button>
							{alternativeAvailable && (
								<Button onClick={() => updateSelection.mutate({ provider: alternative })}>
									Switch to {providerLabel(alternative)}
								</Button>
							)}
						</div>
					</div>
				</div>
			</div>
		);
	}

	if (selection.selected === "tautulli") return <TautulliTab />;
	return <TracearrTab />;
}
