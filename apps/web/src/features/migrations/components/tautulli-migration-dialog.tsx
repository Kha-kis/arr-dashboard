"use client";

import { ArrowRight, Database, Loader2, ShieldAlert } from "lucide-react";
import { Button } from "../../../components/ui";
import {
	useCompleteTautulliMigration,
	useTautulliMigrationStatus,
} from "../../../hooks/api/useSystem";
import { useThemeGradient } from "../../../hooks/useThemeGradient";
import type { TautulliRuleChange } from "../../../lib/api-client/system";
import { getLinuxInstanceName, getLinuxIsoName, useIncognitoMode } from "../../../lib/incognito";

/**
 * Blocking migration dialog for the 3.0 Tautulli removal (ADR-0007).
 *
 * Shown once, app-wide, while pre-3.0 TAUTULLI service instances linger
 * in the database. Deliberately NOT built on the Radix Dialog primitive:
 * there is no dismiss path (no X, no escape, no outside-click), so a
 * plain overlay is the honest implementation — the only way forward is
 * the single acknowledge action.
 *
 * The successor note is informational text, not a CTA — Tracearr
 * integration lands later in the 3.0 cycle (charter C2) and this copy
 * upgrades to a deep link then. A dead button today would be worse.
 */
export const TautulliMigrationDialog = () => {
	const { data } = useTautulliMigrationStatus();
	const completeMutation = useCompleteTautulliMigration();
	const { gradient } = useThemeGradient();
	const [incognitoMode] = useIncognitoMode();

	if (!data?.needed) return null;

	const report = data.rulesReport;
	const disabledRules: TautulliRuleChange[] = report
		? [
				...report.surfaces["library-cleanup"].rulesDisabled,
				...report.surfaces["auto-tag"].rulesDisabled,
			]
		: [];
	const modifiedRules: TautulliRuleChange[] = report
		? [
				...report.surfaces["library-cleanup"].rulesModified,
				...report.surfaces["auto-tag"].rulesModified,
			]
		: [];

	const displayLabel = (label: string) => (incognitoMode ? getLinuxInstanceName(label) : label);
	const displayRuleName = (name: string) => (incognitoMode ? getLinuxIsoName(name) : name);

	return (
		<div
			className="fixed inset-0 z-modal flex items-center justify-center p-4"
			role="alertdialog"
			aria-modal="true"
			aria-labelledby="tautulli-migration-title"
		>
			{/* Backdrop — intentionally not clickable-to-dismiss */}
			<div className="absolute inset-0 backdrop-blur-xs bg-linear-to-br from-black/70 via-black/60 to-black/70" />

			<div
				className="relative w-full max-w-lg rounded-2xl border border-border/50 bg-card/95 backdrop-blur-xl p-6 space-y-4 animate-in fade-in zoom-in-95 duration-300"
				style={{
					boxShadow: `0 25px 50px -12px rgba(0,0,0,0.5), 0 0 80px -20px ${gradient.glow}`,
				}}
			>
				{/* Top gradient accent line */}
				<div
					className="absolute top-0 left-8 right-8 h-px pointer-events-none"
					style={{
						background: `linear-gradient(90deg, transparent, ${gradient.from}, transparent)`,
					}}
				/>

				<div className="flex items-start gap-3">
					<div
						className="flex h-10 w-10 items-center justify-center rounded-lg shrink-0"
						style={{
							background: `linear-gradient(135deg, ${gradient.from}20, ${gradient.to}20)`,
							border: `1px solid ${gradient.from}30`,
						}}
					>
						<Database className="h-5 w-5" style={{ color: gradient.from }} />
					</div>
					<div className="space-y-1">
						<h2 id="tautulli-migration-title" className="text-lg font-semibold text-foreground">
							Tautulli support was removed in 3.0
						</h2>
						<p className="text-sm text-muted-foreground">
							Plex statistics are now captured directly from session snapshots, so the Tautulli
							integration is no longer used. Your configured instance
							{data.instances.length > 1 ? "s" : ""} will be removed from arr-dashboard:
						</p>
					</div>
				</div>

				<ul className="space-y-1">
					{data.instances.map((instance) => (
						<li
							key={instance.id}
							className="flex items-center gap-2 rounded-lg border border-border/30 bg-muted/20 px-3 py-2 text-sm text-foreground"
						>
							<span
								className="h-1.5 w-1.5 rounded-full shrink-0"
								style={{ background: gradient.from }}
							/>
							{displayLabel(instance.label)}
						</li>
					))}
				</ul>

				{(disabledRules.length > 0 || modifiedRules.length > 0) && (
					<div className="rounded-lg border border-border/30 bg-muted/20 p-3 space-y-2">
						<div className="flex items-center gap-2 text-sm font-medium text-foreground">
							<ShieldAlert className="h-4 w-4 text-amber-400" />
							Affected cleanup &amp; auto-tag rules
						</div>
						{disabledRules.length > 0 && (
							<div className="text-xs text-muted-foreground">
								<span className="font-medium text-foreground">
									{disabledRules.length} rule{disabledRules.length > 1 ? "s" : ""} disabled
								</span>{" "}
								(depended entirely on Tautulli data):{" "}
								{disabledRules.map((r) => displayRuleName(r.name)).join(", ")}
							</div>
						)}
						{modifiedRules.length > 0 && (
							<div className="text-xs text-muted-foreground">
								<span className="font-medium text-foreground">
									{modifiedRules.length} rule{modifiedRules.length > 1 ? "s" : ""} modified
								</span>{" "}
								(Tautulli conditions dropped, remaining conditions still active):{" "}
								{modifiedRules.map((r) => displayRuleName(r.name)).join(", ")}
							</div>
						)}
						<p className="text-xs text-muted-foreground">
							Originals were backed up to <code className="text-foreground">rules-pre-3.0/</code> in
							your config directory.
						</p>
					</div>
				)}

				<p className="text-xs text-muted-foreground">
					Your watch history is not lost — it remains safely inside Tautulli itself. Tracearr, the
					upcoming analytics integration, imports history from Tautulli directly when it lands later
					in the 3.0 cycle.
				</p>

				<div className="flex justify-end pt-1">
					<Button
						onClick={() => completeMutation.mutate()}
						disabled={completeMutation.isPending}
						className="gap-2"
					>
						{completeMutation.isPending ? (
							<Loader2 className="h-4 w-4 animate-spin" />
						) : (
							<ArrowRight className="h-4 w-4" />
						)}
						Remove Tautulli &amp; continue
					</Button>
				</div>
			</div>
		</div>
	);
};
