"use client";

import { Activity, ArrowLeft, ArrowRight, Check, Gauge, Workflow } from "lucide-react";
import { useRouter } from "next/navigation";
import { useState } from "react";
import {
	Badge,
	Button,
	Card,
	CardContent,
	CardDescription,
	CardHeader,
	CardTitle,
	Progress,
} from "../../../components/ui";
import { useServicesQuery } from "../../../hooks/api/useServicesQuery";
import { useThemeGradient } from "../../../hooks/useThemeGradient";
import { getLinuxServerName, useIncognitoMode } from "../../../lib/incognito";

const WALKTHROUGH_STEPS = [
	{
		title: "Review your connected stack",
		description:
			"These verified services will feed the dashboard, health signals, and operator actions.",
		icon: Check,
	},
	{
		title: "Start with Overview",
		description:
			"Domain tiles summarize health and recent work. Needs Attention turns Pulse signals into a focused operator queue.",
		icon: Gauge,
	},
	{
		title: "Automate deliberately",
		description:
			"The Automation tab brings cleanup, tagging, notifications, and cross-domain rules into one reviewable surface.",
		icon: Workflow,
	},
] as const;

export const ConsoleWalkthrough = () => {
	const router = useRouter();
	const { gradient } = useThemeGradient();
	const [incognitoMode] = useIncognitoMode();
	const { data: services = [], isLoading } = useServicesQuery();
	const [step, setStep] = useState(0);
	const current = WALKTHROUGH_STEPS[step]!;
	const CurrentIcon = current.icon;
	const isLastStep = step === WALKTHROUGH_STEPS.length - 1;

	return (
		<div className="w-full max-w-3xl space-y-6 py-8">
			<div className="space-y-3 text-center">
				<p className="text-sm uppercase tracking-[0.3em] text-muted-foreground">Step 5 of 5</p>
				<h1
					className="text-3xl font-bold tracking-tight"
					style={{
						background: `linear-gradient(135deg, ${gradient.from}, ${gradient.to})`,
						WebkitBackgroundClip: "text",
						WebkitTextFillColor: "transparent",
					}}
				>
					Meet your Operator Console
				</h1>
				<p className="mx-auto max-w-2xl text-muted-foreground">
					A quick orientation before you take control. Nothing is changed or enabled during this
					walkthrough.
				</p>
			</div>

			<Card className="border-border/50 bg-card/80">
				<CardHeader className="space-y-4">
					<div className="flex items-center justify-between gap-4 text-xs text-muted-foreground">
						<span>
							Orientation {step + 1} of {WALKTHROUGH_STEPS.length}
						</span>
						<Button type="button" variant="ghost" size="sm" onClick={() => router.push("/console")}>
							Skip walkthrough
						</Button>
					</div>
					<Progress value={((step + 1) / WALKTHROUGH_STEPS.length) * 100} />
					<div className="flex items-start gap-3">
						<div className="rounded-xl border border-border/60 bg-muted/30 p-2.5">
							<CurrentIcon className="h-5 w-5" style={{ color: gradient.from }} />
						</div>
						<div>
							<CardTitle>{current.title}</CardTitle>
							<CardDescription className="mt-1">{current.description}</CardDescription>
						</div>
					</div>
				</CardHeader>
				<CardContent>
					{step === 0 && (
						<div className="space-y-3">
							{isLoading ? (
								<p className="text-sm text-muted-foreground">Loading connected services…</p>
							) : services.length > 0 ? (
								<ul className="grid gap-2 sm:grid-cols-2">
									{services.map((service) => (
										<li
											key={service.id}
											className="flex items-center justify-between gap-3 rounded-xl border border-border/60 p-3"
										>
											<span className="min-w-0 truncate text-sm font-medium">
												{incognitoMode ? getLinuxServerName(service.label) : service.label}
											</span>
											<Badge variant="outline" className="shrink-0 capitalize">
												{service.service}
											</Badge>
										</li>
									))}
								</ul>
							) : (
								<div className="rounded-xl border border-border/60 p-4 text-sm text-muted-foreground">
									No services are connected yet. The Console still opens normally, and Settings
									remains the place to add services later.
								</div>
							)}
						</div>
					)}

					{step === 1 && (
						<div className="grid gap-3 sm:grid-cols-2">
							<div className="rounded-xl border border-border/60 p-4">
								<Gauge className="mb-3 h-5 w-5" style={{ color: gradient.from }} />
								<p className="font-medium">Domain health</p>
								<p className="mt-1 text-sm text-muted-foreground">
									Tiles show which parts of the stack are healthy, degraded, disabled, or offline.
								</p>
							</div>
							<div className="rounded-xl border border-border/60 p-4">
								<Activity className="mb-3 h-5 w-5" style={{ color: gradient.to }} />
								<p className="font-medium">Needs Attention</p>
								<p className="mt-1 text-sm text-muted-foreground">
									Actionable Pulse signals appear here with recovery-aware dismissal and safe
									actions.
								</p>
							</div>
						</div>
					)}

					{step === 2 && (
						<div className="space-y-3">
							<div className="rounded-xl border border-border/60 p-4">
								<p className="font-medium">One rule view, explicit lifecycle</p>
								<p className="mt-1 text-sm text-muted-foreground">
									Review existing rules together, author supported domains, and dry-run cross-domain
									rules before deploying them. Drafts do not execute.
								</p>
							</div>
							<p className="text-sm text-muted-foreground">
								Setup is complete. You can return to Settings at any time to connect more services.
							</p>
						</div>
					)}
				</CardContent>
			</Card>

			<div className="flex flex-wrap items-center justify-between gap-3">
				<Button
					type="button"
					variant="ghost"
					onClick={() =>
						step === 0
							? router.push("/setup?stage=trash")
							: setStep((currentStep) => currentStep - 1)
					}
				>
					<ArrowLeft className="h-4 w-4" /> {step === 0 ? "Back to TRaSH profile" : "Back"}
				</Button>
				<Button
					type="button"
					size="lg"
					onClick={() =>
						isLastStep ? router.push("/console") : setStep((currentStep) => currentStep + 1)
					}
				>
					{isLastStep ? "Open Operator Console" : "Continue"}
					<ArrowRight className="h-4 w-4" />
				</Button>
			</div>
		</div>
	);
};
