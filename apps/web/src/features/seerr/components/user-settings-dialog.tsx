"use client";

import type { SeerrQuota, SeerrUser } from "@arr/shared";
import { Film, Loader2, Settings, Tv } from "lucide-react";
import { useEffect, useId, useState } from "react";
import { toast } from "sonner";
import { GradientButton, PremiumProgress } from "../../../components/layout/premium-components";
import {
	Input,
	LegacyDialog,
	LegacyDialogClose,
	LegacyDialogContent,
	LegacyDialogDescription,
	LegacyDialogFooter,
	LegacyDialogHeader,
	LegacyDialogTitle,
} from "../../../components/ui";
import { SimpleFormField } from "../../../components/ui/simple-form-field";
import { useSeerrUserQuota, useUpdateSeerrUser } from "../../../hooks/api/useSeerr";
import { getLinuxUsername, useIncognitoMode } from "../../../lib/incognito";
import { notifySeerrActionError } from "../lib/seerr-action-error";

interface UserSettingsDialogProps {
	user: SeerrUser | null;
	instanceId: string;
	open: boolean;
	onOpenChange: (open: boolean) => void;
}

interface QuotaDraft {
	movieQuotaLimit: number | null;
	movieQuotaDays: number | null;
	tvQuotaLimit: number | null;
	tvQuotaDays: number | null;
}

function initDraft(user: SeerrUser): QuotaDraft {
	return {
		movieQuotaLimit: user.movieQuotaLimit ?? null,
		movieQuotaDays: user.movieQuotaDays ?? null,
		tvQuotaLimit: user.tvQuotaLimit ?? null,
		tvQuotaDays: user.tvQuotaDays ?? null,
	};
}

export const UserSettingsDialog = ({
	user,
	instanceId,
	open,
	onOpenChange,
}: UserSettingsDialogProps) => {
	const formId = useId();
	const [draft, setDraft] = useState<QuotaDraft>({
		movieQuotaLimit: null,
		movieQuotaDays: null,
		tvQuotaLimit: null,
		tvQuotaDays: null,
	});
	const [incognitoMode] = useIncognitoMode();
	const updateMutation = useUpdateSeerrUser();
	const { data, isError, isLoading } = useSeerrUserQuota(instanceId, user?.id ?? 0);
	const quota = isError ? undefined : data;

	// Sync draft from user props when dialog opens
	useEffect(() => {
		if (open && user) {
			setDraft(initDraft(user));
		}
	}, [open, user]);

	if (!user) return null;

	const original = initDraft(user);
	const hasChanges =
		draft.movieQuotaLimit !== original.movieQuotaLimit ||
		draft.movieQuotaDays !== original.movieQuotaDays ||
		draft.tvQuotaLimit !== original.tvQuotaLimit ||
		draft.tvQuotaDays !== original.tvQuotaDays;

	const handleSave = async () => {
		if (!hasChanges || updateMutation.isPending) return;
		const displayName = incognitoMode ? getLinuxUsername(user.displayName) : user.displayName;
		try {
			await updateMutation.mutateAsync({ instanceId, seerrUserId: user.id, data: draft });
			toast.success(`Updated quota settings for ${displayName}`);
			onOpenChange(false);
		} catch (error) {
			notifySeerrActionError(error, `Failed to update quota for ${displayName}`);
		}
	};

	return (
		<LegacyDialog open={open} onOpenChange={onOpenChange} size="md">
			<LegacyDialogClose onClick={() => onOpenChange(false)} />
			<LegacyDialogHeader>
				<LegacyDialogTitle>
					<div className="flex items-center gap-2">
						<Settings className="h-5 w-5" />
						{incognitoMode ? getLinuxUsername(user.displayName) : user.displayName}
					</div>
				</LegacyDialogTitle>
				<LegacyDialogDescription>
					Configure request quota limits for this user. Leave fields empty for unlimited.
				</LegacyDialogDescription>
			</LegacyDialogHeader>

			<LegacyDialogContent className="space-y-6">
				{!quota && (
					<p className="text-xs text-muted-foreground">
						{isLoading ? "Loading quota…" : "Quota unavailable"}
					</p>
				)}
				{/* Movie Quota */}
				<QuotaSection
					icon={Film}
					label="Movie Quota"
					formId={formId}
					limit={draft.movieQuotaLimit}
					days={draft.movieQuotaDays}
					quota={quota?.movie}
					onLimitChange={(v) => setDraft((prev) => ({ ...prev, movieQuotaLimit: v }))}
					onDaysChange={(v) => setDraft((prev) => ({ ...prev, movieQuotaDays: v }))}
				/>

				{/* TV Quota */}
				<QuotaSection
					icon={Tv}
					label="TV Quota"
					formId={formId}
					limit={draft.tvQuotaLimit}
					days={draft.tvQuotaDays}
					quota={quota?.tv}
					onLimitChange={(v) => setDraft((prev) => ({ ...prev, tvQuotaLimit: v }))}
					onDaysChange={(v) => setDraft((prev) => ({ ...prev, tvQuotaDays: v }))}
				/>
			</LegacyDialogContent>

			<LegacyDialogFooter>
				<GradientButton
					size="sm"
					variant="primary"
					disabled={!hasChanges || updateMutation.isPending}
					onClick={() => void handleSave()}
					icon={updateMutation.isPending ? Loader2 : undefined}
				>
					{updateMutation.isPending ? "Saving..." : "Save"}
				</GradientButton>
			</LegacyDialogFooter>
		</LegacyDialog>
	);
};

// ---------------------------------------------------------------------------
// Quota section — reused for movie and TV
// ---------------------------------------------------------------------------

interface QuotaSectionProps {
	icon: React.ComponentType<{ className?: string }>;
	label: string;
	formId: string;
	limit: number | null;
	days: number | null;
	quota?: SeerrQuota["movie"];
	onLimitChange: (value: number | null) => void;
	onDaysChange: (value: number | null) => void;
}

function QuotaSection({
	icon: Icon,
	label,
	formId,
	limit,
	days,
	quota,
	onLimitChange,
	onDaysChange,
}: QuotaSectionProps) {
	const limitId = `${formId}-${label}-limit`;
	const daysId = `${formId}-${label}-days`;

	return (
		<div className="space-y-3">
			<div className="flex items-center gap-2">
				<Icon className="h-4 w-4 text-muted-foreground" />
				<h4 className="text-sm font-semibold text-foreground">{label}</h4>
			</div>

			{quota &&
				(quota.limit > 0 ? (
					<div className="flex items-center gap-3 rounded-lg border border-border/50 bg-background/50 px-3 py-2">
						<div className="min-w-0 flex-1">
							<PremiumProgress
								value={quota.used}
								max={quota.limit}
								variant={quota.restricted ? "danger" : "default"}
							/>
						</div>
						<span className="shrink-0 text-xs text-muted-foreground">
							{quota.used} of {quota.limit} used
						</span>
						{quota.restricted && <span className="text-xs text-destructive">Exhausted</span>}
					</div>
				) : (
					<p className="text-xs text-muted-foreground">
						{quota.limit === 0 ? "Unlimited" : "Unavailable"}
					</p>
				))}

			<div className="grid grid-cols-2 gap-3">
				<SimpleFormField label="Request limit" htmlFor={limitId} hint="Max requests allowed">
					<Input
						id={limitId}
						premium
						type="number"
						min={0}
						placeholder="Unlimited"
						value={limit != null ? String(limit) : ""}
						onChange={(e) => onLimitChange(e.target.value === "" ? null : Number(e.target.value))}
					/>
				</SimpleFormField>

				<SimpleFormField label="Days" htmlFor={daysId} hint="Rolling window in days">
					<Input
						id={daysId}
						premium
						type="number"
						min={1}
						placeholder="Unlimited"
						value={days != null ? String(days) : ""}
						onChange={(e) => onDaysChange(e.target.value === "" ? null : Number(e.target.value))}
					/>
				</SimpleFormField>
			</div>
		</div>
	);
}
