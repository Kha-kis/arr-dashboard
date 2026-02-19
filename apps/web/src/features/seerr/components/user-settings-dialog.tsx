"use client";

import { useState, useEffect, useId } from "react";
import { Settings, Loader2, Film, Tv } from "lucide-react";
import { toast } from "sonner";
import type { SeerrUser, SeerrQuota } from "@arr/shared";
import {
	LegacyDialog,
	LegacyDialogHeader,
	LegacyDialogTitle,
	LegacyDialogDescription,
	LegacyDialogContent,
	LegacyDialogFooter,
	LegacyDialogClose,
	Input,
} from "../../../components/ui";
import { SimpleFormField } from "../../../components/ui/simple-form-field";
import { GradientButton, PremiumProgress } from "../../../components/layout/premium-components";
import { useSeerrUserQuota, useUpdateSeerrUser } from "../../../hooks/api/useSeerr";

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
	const updateMutation = useUpdateSeerrUser();
	const { data: quota } = useSeerrUserQuota(instanceId, user?.id ?? 0);

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

	const handleSave = () => {
		updateMutation.mutate(
			{ instanceId, seerrUserId: user.id, data: draft },
			{
				onSuccess: () => {
					toast.success(`Updated quota settings for ${user.displayName}`);
					onOpenChange(false);
				},
				onError: () => toast.error(`Failed to update quota for ${user.displayName}`),
			},
		);
	};

	return (
		<LegacyDialog open={open} onOpenChange={onOpenChange} size="md">
			<LegacyDialogClose onClick={() => onOpenChange(false)} />
			<LegacyDialogHeader>
				<LegacyDialogTitle>
					<div className="flex items-center gap-2">
						<Settings className="h-5 w-5" />
						{user.displayName}
					</div>
				</LegacyDialogTitle>
				<LegacyDialogDescription>
					Configure request quota limits for this user. Leave fields empty for unlimited.
				</LegacyDialogDescription>
			</LegacyDialogHeader>

			<LegacyDialogContent className="space-y-6">
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
					onClick={handleSave}
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

			{/* Current usage bar */}
			{quota?.restricted && quota.limit > 0 && (
				<div className="flex items-center gap-3 rounded-lg border border-border/50 bg-background/50 px-3 py-2">
					<div className="min-w-0 flex-1">
						<PremiumProgress value={Math.round((quota.used / quota.limit) * 100)} max={100} />
					</div>
					<span className="shrink-0 text-xs text-muted-foreground">
						{quota.used} of {quota.limit} used
					</span>
				</div>
			)}

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
