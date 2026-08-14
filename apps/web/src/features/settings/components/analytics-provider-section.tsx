"use client";

import type { AnalyticsProvider } from "@arr/shared";
import { BarChart3, Check, Settings2 } from "lucide-react";
import Link from "next/link";
import { useRef, useState } from "react";
import {
	Button,
	Dialog,
	DialogContent,
	DialogDescription,
	DialogFooter,
	DialogHeader,
	DialogTitle,
} from "../../../components/ui";
import {
	useAnalyticsProviderSelection,
	useUpdateAnalyticsProviderSelection,
} from "../../../hooks/api/useSystem";

const PROVIDERS: Array<{ id: AnalyticsProvider; label: string; summary: string }> = [
	{
		id: "tracearr",
		label: "Tracearr",
		summary: "Recommended for new historical analytics setups.",
	},
	{
		id: "tautulli",
		label: "Tautulli",
		summary: "Alternative for supported Plex analytics setups.",
	},
];

const providerLabel = (provider: AnalyticsProvider) =>
	PROVIDERS.find((candidate) => candidate.id === provider)?.label ?? provider;

export function AnalyticsProviderSection() {
	const { data: selection, isError, isLoading, refetch } = useAnalyticsProviderSelection();
	const updateSelection = useUpdateAnalyticsProviderSelection();
	const [pendingProvider, setPendingProvider] = useState<AnalyticsProvider | null>(null);
	const radioRefs = useRef<Partial<Record<AnalyticsProvider, HTMLInputElement | null>>>({});

	if (isError) {
		return (
			<section
				className="rounded-xl border border-destructive/50 bg-destructive/10 p-5"
				role="alert"
			>
				<h2 className="font-semibold">Historical analytics provider is unavailable</h2>
				<p className="mt-1 text-sm text-muted-foreground">
					The provider selection could not be loaded. Retry to choose which provider family controls
					historical analytics.
				</p>
				<Button
					className="mt-4"
					variant="secondary"
					onClick={() => void refetch()}
					aria-label="Retry analytics provider selection"
				>
					Retry
				</Button>
			</section>
		);
	}

	if (isLoading || !selection) {
		return <div className="h-40 animate-pulse rounded-xl border border-border/50 bg-card/30" />;
	}

	const requestSelection = (provider: AnalyticsProvider) => {
		if (provider === selection.selected) return;
		if (selection.status === "configured") {
			setPendingProvider(provider);
			return;
		}
		updateSelection.mutate({ provider });
	};

	const selectedFamily = selection.families[selection.selected];
	const alternative = PROVIDERS.find((provider) => provider.id !== selection.selected)!;
	const alternativeAvailable = selection.families[alternative.id].enabledCount > 0;
	const selectedUnavailable = selection.status !== "configured";

	return (
		<section
			className="space-y-4 rounded-xl border border-border/50 bg-card/30 p-5"
			aria-labelledby="analytics-provider-title"
		>
			<div className="flex items-start gap-3">
				<div className="rounded-lg bg-muted/50 p-2">
					<BarChart3 className="h-5 w-5" />
				</div>
				<div>
					<h2 id="analytics-provider-title" className="font-semibold">
						Historical analytics provider
					</h2>
					<p className="text-sm text-muted-foreground">
						Choose one provider family for historical analytics. This selection does not copy data
						or automatically fail over.
					</p>
				</div>
			</div>

			<div
				id="analytics-provider"
				role="radiogroup"
				aria-label="Historical analytics provider"
				className="grid gap-3 sm:grid-cols-2"
			>
				{PROVIDERS.map((provider, index) => {
					const selected = provider.id === selection.selected;
					return (
						<label
							key={provider.id}
							className={`rounded-xl border p-4 text-left transition-colors has-[input:focus-visible]:ring-2 has-[input:focus-visible]:ring-ring ${
								selected ? "border-primary bg-primary/10" : "border-border/50 hover:border-border"
							}`}
						>
							<input
								ref={(node) => {
									radioRefs.current[provider.id] = node;
								}}
								className="sr-only"
								type="radio"
								name="analytics-provider"
								checked={selected}
								onChange={() => requestSelection(provider.id)}
								aria-label={`${provider.label} ${provider.id === "tracearr" ? "Recommended" : "Alternative"}`}
								onKeyDown={(event) => {
									if (event.key !== "ArrowLeft" && event.key !== "ArrowRight") return;
									event.preventDefault();
									const direction = event.key === "ArrowRight" ? 1 : -1;
									const next =
										PROVIDERS[(index + direction + PROVIDERS.length) % PROVIDERS.length]!;
									radioRefs.current[next.id]?.focus();
									queueMicrotask(() => requestSelection(next.id));
								}}
							/>
							<div className="flex items-center justify-between gap-2">
								<span className="font-medium">{provider.label}</span>
								<span className="text-xs font-medium text-muted-foreground">
									{provider.id === "tracearr" ? "Recommended" : "Alternative"}
								</span>
							</div>
							<p className="mt-1 text-sm text-muted-foreground">{provider.summary}</p>
							{selected && (
								<span className="mt-3 flex items-center gap-1 text-sm font-medium text-primary">
									<Check className="h-4 w-4" /> Selected
								</span>
							)}
						</label>
					);
				})}
			</div>

			{selectedUnavailable && (
				<div className="flex flex-wrap items-center gap-3 rounded-lg border border-warning/50 bg-warning/10 p-4 text-sm">
					<Settings2 className="h-4 w-4 shrink-0 text-warning" />
					<p className="flex-1">
						{providerLabel(selection.selected)} is selected but unavailable. Configure it to keep
						historical analytics with the selected provider.
					</p>
					<Link className="font-medium underline underline-offset-4" href="#services">
						Configure selected provider
					</Link>
					{alternativeAvailable && (
						<Button size="sm" variant="secondary" onClick={() => requestSelection(alternative.id)}>
							Switch to {providerLabel(alternative.id)}
						</Button>
					)}
				</div>
			)}

			<p className="text-xs text-muted-foreground">
				{selectedFamily.enabledCount} enabled {providerLabel(selection.selected)} instance
				{selectedFamily.enabledCount === 1 ? "" : "s"}.
			</p>

			<Dialog
				open={pendingProvider !== null}
				onOpenChange={(open) => !open && setPendingProvider(null)}
			>
				<DialogContent>
					<DialogHeader>
						<DialogTitle>Switch historical analytics provider?</DialogTitle>
						<DialogDescription>
							Historical analytics will change to{" "}
							{pendingProvider ? providerLabel(pendingProvider) : "the selected provider"}. Native
							media-server live sessions do not change. This does not migrate, copy, or
							automatically fail over historical data.
						</DialogDescription>
					</DialogHeader>
					<DialogFooter>
						<Button variant="secondary" onClick={() => setPendingProvider(null)}>
							Cancel
						</Button>
						<Button
							disabled={updateSelection.isPending || !pendingProvider}
							onClick={() => {
								if (!pendingProvider) return;
								updateSelection.mutate({ provider: pendingProvider });
								setPendingProvider(null);
							}}
						>
							Switch to {pendingProvider ? providerLabel(pendingProvider) : "provider"}
						</Button>
					</DialogFooter>
				</DialogContent>
			</Dialog>
		</section>
	);
}
