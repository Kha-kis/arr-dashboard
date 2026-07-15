"use client";

import type { SetupStarterId, SetupStarterKind, SetupStarterService } from "@arr/shared";
import { ArrowLeft, ArrowRight, Bell, Loader2, ShieldCheck, Tags, Workflow } from "lucide-react";
import { useRouter } from "next/navigation";
import { useState } from "react";
import {
	Alert,
	AlertDescription,
	Badge,
	Button,
	Card,
	CardContent,
	CardDescription,
	CardHeader,
	CardTitle,
	Checkbox,
} from "../../../components/ui";
import { useApplySetupStarters, useSetupStarters } from "../../../hooks/api/useSetupStarters";
import { useThemeGradient } from "../../../hooks/useThemeGradient";
import { getErrorMessage } from "../../../lib/error-utils";
import { getLinuxServerName, useIncognitoMode } from "../../../lib/incognito";

const STARTER_ICONS: Record<SetupStarterKind, typeof Bell> = {
	notifications: Bell,
	"auto-tag": Tags,
	"label-sync": Workflow,
};

const serviceName = (service: SetupStarterService, incognitoMode: boolean) =>
	incognitoMode ? getLinuxServerName(service.label) : service.label;

export const StarterConfiguration = () => {
	const router = useRouter();
	const { gradient } = useThemeGradient();
	const [incognitoMode] = useIncognitoMode();
	const { data, isLoading, error } = useSetupStarters();
	const applyStarters = useApplySetupStarters();
	const [selected, setSelected] = useState<Set<SetupStarterId>>(new Set());
	const [appliedCount, setAppliedCount] = useState(0);

	const toggleStarter = (id: SetupStarterId, checked: boolean) => {
		setSelected((current) => {
			const next = new Set(current);
			if (checked) next.add(id);
			else next.delete(id);
			return next;
		});
	};

	const handleApply = async () => {
		if (selected.size === 0) return;
		const result = await applyStarters.mutateAsync({ starterIds: [...selected] });
		setAppliedCount(result.created.length);
		setSelected(new Set());
	};

	return (
		<div className="w-full max-w-4xl space-y-6 pb-24 pt-8">
			<div className="space-y-3 text-center">
				<p className="text-sm uppercase tracking-[0.3em] text-muted-foreground">Step 3 of 4</p>
				<h1
					className="text-3xl font-bold tracking-tight"
					style={{
						background: `linear-gradient(135deg, ${gradient.from}, ${gradient.to})`,
						WebkitBackgroundClip: "text",
						WebkitTextFillColor: "transparent",
					}}
				>
					Choose a safe starting point
				</h1>
				<p className="mx-auto max-w-2xl text-muted-foreground">
					Starter rules are optional and always created disabled. Review them later in the Operator
					Console before enabling anything.
				</p>
			</div>

			{appliedCount > 0 && (
				<Alert>
					<ShieldCheck className="h-4 w-4" />
					<AlertDescription>
						Created {appliedCount} disabled {appliedCount === 1 ? "draft" : "drafts"}. No automation
						has run.
					</AlertDescription>
				</Alert>
			)}

			<Card className="border-border/50 bg-card/80">
				<CardHeader>
					<CardTitle>Optional starter drafts</CardTitle>
					<CardDescription>
						Select only the examples you want to keep and customize.
					</CardDescription>
				</CardHeader>
				<CardContent className="space-y-3">
					{isLoading && (
						<div className="flex items-center gap-2 py-8 text-sm text-muted-foreground">
							<Loader2 className="h-4 w-4 animate-spin" /> Loading available starters…
						</div>
					)}
					{error && (
						<Alert variant="destructive">
							<AlertDescription>{getErrorMessage(error)}</AlertDescription>
						</Alert>
					)}
					{data?.starters.map((starter) => {
						const Icon = STARTER_ICONS[starter.kind];
						const disabled = !starter.available || starter.existing || applyStarters.isPending;
						return (
							<label
								key={starter.id}
								htmlFor={`starter-${starter.id}`}
								className="flex cursor-pointer items-start gap-3 rounded-xl border border-border/60 p-4 has-[:disabled]:cursor-not-allowed has-[:disabled]:opacity-60"
							>
								<Checkbox
									id={`starter-${starter.id}`}
									checked={selected.has(starter.id)}
									disabled={disabled}
									onCheckedChange={(checked) => toggleStarter(starter.id, checked === true)}
									className="mt-1"
								/>
								<div className="min-w-0 flex-1 space-y-2">
									<div className="flex flex-wrap items-center gap-2">
										<Icon className="h-4 w-4" style={{ color: gradient.from }} />
										<span className="font-medium">{starter.title}</span>
										<Badge variant="outline" className="capitalize">
											{starter.kind.replace("-", " ")}
										</Badge>
										{starter.existing && <Badge variant="secondary">Already exists</Badge>}
									</div>
									<p className="text-sm text-muted-foreground">{starter.description}</p>
									<p className="text-sm">{starter.effect}</p>
									{starter.source && (
										<p className="text-xs text-muted-foreground">
											Source: {serviceName(starter.source, incognitoMode)}
											{starter.destination && (
												<>
													{" → "}
													{serviceName(starter.destination, incognitoMode)}
												</>
											)}
										</p>
									)}
									{starter.unavailableReason && (
										<p className="text-xs text-muted-foreground">{starter.unavailableReason}</p>
									)}
								</div>
							</label>
						);
					})}
				</CardContent>
			</Card>

			<Card className="border-border/50 bg-card/80">
				<CardContent className="flex items-start gap-3 p-4">
					<ShieldCheck className="mt-0.5 h-5 w-5" style={{ color: gradient.to }} />
					<div>
						<p className="font-medium">TRaSH quality profiles require a deployment preview</p>
						<p className="mt-1 text-sm text-muted-foreground">
							Setup will not guess a quality profile or change Sonarr/Radarr settings. TRaSH Guides
							remains available after setup with a full before-and-after review.
						</p>
					</div>
				</CardContent>
			</Card>

			{applyStarters.error && (
				<Alert variant="destructive">
					<AlertDescription>{getErrorMessage(applyStarters.error)}</AlertDescription>
				</Alert>
			)}

			<div className="flex flex-wrap items-center justify-between gap-3">
				<Button type="button" variant="ghost" onClick={() => router.push("/setup?stage=services")}>
					<ArrowLeft className="h-4 w-4" /> Back to services
				</Button>
				<div className="flex flex-wrap gap-2">
					{selected.size > 0 && (
						<Button
							type="button"
							variant="outline"
							onClick={handleApply}
							disabled={applyStarters.isPending}
						>
							{applyStarters.isPending && <Loader2 className="h-4 w-4 animate-spin" />}
							Create {selected.size} disabled {selected.size === 1 ? "draft" : "drafts"}
						</Button>
					)}
					<Button type="button" size="lg" onClick={() => router.push("/setup?stage=console")}>
						{selected.size > 0 ? "Continue without creating" : "Continue"}
						<ArrowRight className="h-4 w-4" />
					</Button>
				</div>
			</div>
		</div>
	);
};
