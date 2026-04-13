"use client";

/**
 * Security Posture section.
 *
 * Read-only diagnostic surface that answers three operator questions:
 *   1. Am I running this safely?              -> overall badge
 *   2. What is misconfigured right now?       -> per-check severity + detail
 *   3. What should I fix first?               -> remediation hints
 *
 * All severity / copy decisions come from the backend evaluator
 * (`evaluateSecurityPosture`). This component is presentation-only.
 */

import {
	AlertTriangle,
	CheckCircle2,
	Fingerprint,
	KeyRound,
	ShieldAlert,
	ShieldCheck,
	ShieldX,
	UserCheck,
} from "lucide-react";
import type { ReactNode } from "react";
import { PremiumSection, PremiumSkeleton, StatusBadge } from "../../../components/layout";
import type {
	SecurityCheck,
	SecurityPosture,
	SecuritySeverity,
} from "../../../lib/api-client/system";
import { cn } from "../../../lib/utils";

interface Props {
	posture: SecurityPosture | undefined;
	isLoading: boolean;
}

const SEVERITY_BADGE: Record<
	SecuritySeverity,
	{ variant: "success" | "warning" | "error"; icon: typeof CheckCircle2; label: string }
> = {
	healthy: { variant: "success", icon: CheckCircle2, label: "Healthy" },
	warning: { variant: "warning", icon: AlertTriangle, label: "Warning" },
	misconfigured: { variant: "error", icon: ShieldX, label: "Misconfigured" },
};

const OVERALL_COPY: Record<SecuritySeverity, { title: string; description: string }> = {
	healthy: {
		title: "All checks passing",
		description: "No misconfigurations detected in your current security setup.",
	},
	warning: {
		title: "Recommended improvements",
		description:
			"Your setup is functional but a hardening opportunity is available — review the warnings below.",
	},
	misconfigured: {
		title: "Action required",
		description:
			"At least one critical security setting is misconfigured. Address the items below to avoid lockouts or insecure sessions.",
	},
};

const OVERALL_ICON: Record<SecuritySeverity, typeof ShieldCheck> = {
	healthy: ShieldCheck,
	warning: ShieldAlert,
	misconfigured: ShieldX,
};

export function SecurityPostureSection({ posture, isLoading }: Props) {
	if (isLoading && !posture) {
		return (
			<PremiumSection
				title="Security Posture"
				description="Effective runtime security configuration and warnings"
				icon={ShieldCheck}
			>
				<div className="space-y-3">
					<PremiumSkeleton className="h-20" />
					<PremiumSkeleton className="h-12" />
					<PremiumSkeleton className="h-12" />
					<PremiumSkeleton className="h-12" />
				</div>
			</PremiumSection>
		);
	}

	if (!posture) {
		return (
			<PremiumSection
				title="Security Posture"
				description="Effective runtime security configuration and warnings"
				icon={ShieldCheck}
			>
				<p className="text-sm text-muted-foreground">Unable to load security posture.</p>
			</PremiumSection>
		);
	}

	// Sort: misconfigured -> warning -> healthy. Within a severity, preserve
	// backend insertion order so the operator-prioritized list matches the
	// rule order in security-posture.ts.
	const severityRank: Record<SecuritySeverity, number> = {
		misconfigured: 0,
		warning: 1,
		healthy: 2,
	};
	const sortedChecks = [...posture.checks].sort(
		(a, b) => severityRank[a.severity] - severityRank[b.severity],
	);

	return (
		<PremiumSection
			title="Security Posture"
			description="Effective runtime security configuration and warnings"
			icon={ShieldCheck}
		>
			<div className="space-y-4">
				<OverallBanner posture={posture} />
				<AuthSummary posture={posture} />
				<div className="space-y-2">
					{sortedChecks.map((check, index) => (
						<CheckRow key={check.id} check={check} index={index} />
					))}
				</div>
				<EnvironmentFootnote posture={posture} />
			</div>
		</PremiumSection>
	);
}

function OverallBanner({ posture }: { posture: SecurityPosture }) {
	const Icon = OVERALL_ICON[posture.overall];
	const copy = OVERALL_COPY[posture.overall];
	const badge = SEVERITY_BADGE[posture.overall];

	const tone =
		posture.overall === "misconfigured"
			? "border-red-500/30 bg-red-500/5"
			: posture.overall === "warning"
				? "border-amber-500/30 bg-amber-500/5"
				: "border-emerald-500/30 bg-emerald-500/5";

	const iconTone =
		posture.overall === "misconfigured"
			? "text-red-500"
			: posture.overall === "warning"
				? "text-amber-500"
				: "text-emerald-500";

	return (
		<div className={cn("flex items-start gap-3 rounded-xl border p-4", tone)}>
			<Icon className={cn("h-6 w-6 shrink-0 mt-0.5", iconTone)} aria-hidden="true" />
			<div className="min-w-0 flex-1">
				<div className="flex items-center gap-2">
					<p className="text-sm font-semibold text-foreground">{copy.title}</p>
					<StatusBadge status={badge.variant} icon={badge.icon}>
						{badge.label}
					</StatusBadge>
				</div>
				<p className="text-xs text-muted-foreground mt-1">{copy.description}</p>
			</div>
		</div>
	);
}

function AuthSummary({ posture }: { posture: SecurityPosture }) {
	return (
		<div className="grid gap-2 sm:grid-cols-3">
			<AuthBadge
				icon={KeyRound}
				label="Password auth"
				active={posture.auth.passwordEnabled}
				detail={
					posture.auth.passwordEnabled
						? `${posture.auth.passwordUserCount} user${
								posture.auth.passwordUserCount === 1 ? "" : "s"
							}`
						: "No users with password set"
				}
			/>
			<AuthBadge
				icon={UserCheck}
				label="OIDC"
				active={posture.auth.oidcEnabled}
				detail={posture.auth.oidcEnabled ? "Provider enabled" : "Not configured"}
			/>
			<AuthBadge
				icon={Fingerprint}
				label="Passkeys"
				active={posture.auth.passkeyCount > 0}
				detail={
					posture.auth.passkeyCount > 0
						? `${posture.auth.passkeyCount} credential${posture.auth.passkeyCount === 1 ? "" : "s"}`
						: "None registered"
				}
			/>
		</div>
	);
}

function AuthBadge({
	icon: Icon,
	label,
	active,
	detail,
}: {
	icon: typeof KeyRound;
	label: string;
	active: boolean;
	detail: string;
}) {
	return (
		<div
			className={cn(
				"flex items-start gap-3 rounded-lg border p-3 transition-colors",
				active ? "border-emerald-500/30 bg-emerald-500/5" : "border-border/40 bg-muted/10",
			)}
		>
			<Icon
				className={cn(
					"h-4 w-4 shrink-0 mt-0.5",
					active ? "text-emerald-500" : "text-muted-foreground",
				)}
				aria-hidden="true"
			/>
			<div className="min-w-0 flex-1">
				<p className="text-xs font-semibold text-foreground">{label}</p>
				<p className="text-xs text-muted-foreground mt-0.5 truncate">{detail}</p>
			</div>
		</div>
	);
}

function CheckRow({ check, index }: { check: SecurityCheck; index: number }) {
	const badge = SEVERITY_BADGE[check.severity];
	return (
		<div
			className="flex items-start gap-3 rounded-lg border border-border/30 bg-muted/10 p-3 animate-in fade-in slide-in-from-bottom-1"
			style={{ animationDelay: `${index * 30}ms`, animationFillMode: "backwards" }}
		>
			<div className="min-w-0 flex-1 space-y-1">
				<div className="flex items-center gap-2 flex-wrap">
					<p className="text-sm font-semibold text-foreground">{check.label}</p>
					<StatusBadge status={badge.variant} icon={badge.icon}>
						{badge.label}
					</StatusBadge>
				</div>
				<p className="text-xs text-muted-foreground">{check.detail}</p>
				{check.remediation && (
					<p className="text-xs font-medium text-foreground/80">
						<span className="text-muted-foreground">Fix: </span>
						{check.remediation}
					</p>
				)}
			</div>
		</div>
	);
}

function EnvironmentFootnote({ posture }: { posture: SecurityPosture }) {
	const items: { label: string; value: ReactNode }[] = [
		{ label: "NODE_ENV", value: posture.effective.nodeEnv },
		{ label: "Trust Proxy", value: posture.effective.trustProxy ? "on" : "off" },
		{ label: "Secure Cookies", value: posture.effective.secureCookies ? "on" : "off" },
		{ label: "Session TTL", value: `${posture.effective.sessionTtlHours}h` },
		{ label: "Password Policy", value: posture.effective.passwordPolicy },
	];

	return (
		<div className="flex flex-wrap gap-x-4 gap-y-1 pt-2 border-t border-border/30 text-xs text-muted-foreground">
			<span className="font-medium text-foreground/70">Effective runtime:</span>
			{items.map((item) => (
				<span key={item.label}>
					<span className="text-foreground/60">{item.label}:</span>{" "}
					<span className="font-mono">{item.value}</span>
				</span>
			))}
		</div>
	);
}
