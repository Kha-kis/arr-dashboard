"use client";

import type { LabelSyncRule } from "@arr/shared";
import { CheckCircle2, Pencil, Play, Plus, Tag, Trash2, XCircle } from "lucide-react";
import { useState } from "react";
import { useIncognitoMode } from "../../../contexts/IncognitoContext";
import { getLinuxSectionName } from "../../../lib/incognito";
import { getErrorMessage } from "../../../lib/error-utils";
import { ApiError } from "../../../lib/api-client/base";
import { GlassmorphicCard, PageLayout } from "../../../components/layout";
import { Button } from "../../../components/ui/button";
import {
	useDeleteLabelSyncRule,
	useLabelSyncRules,
	useRunLabelSyncRule,
} from "../../../hooks/api/useLabelSync";
import { useThemeGradient } from "../../../hooks/useThemeGradient";
import { SERVICE_LABEL_BY_VALUE } from "../service-registry";
import { RuleDialog } from "./rule-dialog";
import { RecoveryStatus } from "./recovery-status";

export const LabelSyncClient = () => {
	const [incognitoMode] = useIncognitoMode();
	const { gradient } = useThemeGradient();
	const { data: rules = [], isLoading, isError, refetch: refetchRules } = useLabelSyncRules();
	const deleteMutation = useDeleteLabelSyncRule();
	const runMutation = useRunLabelSyncRule();
	const [runningId, setRunningId] = useState<string | null>(null);

	const [dialogOpen, setDialogOpen] = useState(false);
	const [editingRule, setEditingRule] = useState<LabelSyncRule | null>(null);

	const openCreate = () => {
		setEditingRule(null);
		setDialogOpen(true);
	};

	const openEdit = (rule: LabelSyncRule) => {
		setEditingRule(rule);
		setDialogOpen(true);
	};

	const handleDelete = async (rule: LabelSyncRule) => {
		if (
			!confirm(
				`Delete rule "${incognitoMode ? getLinuxSectionName(rule.name) : rule.name}"? This cannot be undone.`,
			)
		)
			return;
		await deleteMutation.mutateAsync(rule.id);
	};

	const handleRun = async (rule: LabelSyncRule) => {
		if (!rule.destinationMutationCapability.supported) return;
		if (!rule.enabled) {
			alert("Rule is disabled. Enable it before running.");
			return;
		}
		setRunningId(rule.id);
		try {
			const updated = await runMutation.mutateAsync(rule.id);
			const runOutcome = `Run outcome: ${updated.lastRunStatus?.toUpperCase() ?? "UNKNOWN"}\n\n${incognitoMode ? "Run details hidden in incognito mode." : (updated.lastRunMessage ?? "")}`;
			if (!updated.recovery || updated.recovery.availability === "unavailable") {
				alert(
					`${runOutcome}\n\nRecovery status is unavailable; do not assume held work is resolved.`,
				);
			} else if (updated.recovery.state === "restored-held") {
				alert(
					`${runOutcome}\n\n${updated.recovery.heldCount} restored operations remain held; no automatic resend.`,
				);
			} else if (updated.recovery.state === "reconciled") {
				alert(
					`${runOutcome}\n\nRestored desired state observed; this does not acknowledge the original send.`,
				);
			} else {
				alert(
					`${updated.lastRunStatus?.toUpperCase() ?? "DONE"}\n\n${incognitoMode ? "Run details hidden in incognito mode." : (updated.lastRunMessage ?? "")}`,
				);
			}
		} catch (err) {
			if (
				err instanceof ApiError &&
				err.status === 409 &&
				typeof err.payload === "object" &&
				err.payload !== null &&
				"code" in err.payload &&
				err.payload.code === "label_sync_rule_changed"
			) {
				await refetchRules({ cancelRefetch: false });
				alert(
					"Label Sync execution finished, but its result could not be saved because the rule changed or was deleted. Review the current rule and destination before running again.",
				);
				return;
			}
			alert(
				incognitoMode
					? "Run failed; details hidden in incognito mode."
					: `Run failed: ${getErrorMessage(err)}`,
			);
		} finally {
			setRunningId(null);
		}
	};

	return (
		<PageLayout>
			<div className="space-y-6 animate-in fade-in duration-300">
				{/* Header */}
				<header className="flex flex-col items-start justify-between gap-4 sm:flex-row">
					<div className="space-y-1">
						<div className="flex items-center gap-2 text-sm text-muted-foreground">
							<Tag className="h-4 w-4" />
							<span>Automation</span>
						</div>
						<h1 className="text-3xl font-bold tracking-tight">
							<span
								style={{
									background: `linear-gradient(135deg, ${gradient.from}, ${gradient.to})`,
									WebkitBackgroundClip: "text",
									WebkitTextFillColor: "transparent",
									backgroundClip: "text",
								}}
							>
								Label Sync
							</span>
						</h1>
						<p className="text-muted-foreground max-w-xl">
							Auto-apply tags and labels across supported services. Sources: Sonarr, Radarr, Plex,
							Jellyfin, Emby. Destinations: Sonarr, Radarr, Plex, or Jellyfin; Emby is temporarily
							unavailable.
						</p>
					</div>
					<Button onClick={openCreate} className="shrink-0">
						<Plus className="h-4 w-4 mr-2" /> New Rule
					</Button>
				</header>

				{/* Rules list */}
				<GlassmorphicCard>
					{isLoading ? (
						<div className="p-6 text-sm text-muted-foreground">Loading rules…</div>
					) : isError && rules.length === 0 ? (
						<div role="alert" className="p-6 text-sm text-muted-foreground">
							Rules are unavailable. Please try again when the connection recovers.
						</div>
					) : rules.length === 0 ? (
						<EmptyState onCreateClick={openCreate} />
					) : (
						<RuleTable
							rules={rules}
							runningId={runningId}
							recoveryUnavailable={isError}
							incognitoMode={incognitoMode}
							onEdit={openEdit}
							onDelete={handleDelete}
							onRun={handleRun}
						/>
					)}
				</GlassmorphicCard>
			</div>

			{/* Create/Edit dialog */}
			{dialogOpen && (
				<RuleDialog
					rule={editingRule}
					onClose={() => {
						setDialogOpen(false);
						setEditingRule(null);
					}}
				/>
			)}
		</PageLayout>
	);
};

const EmptyState = ({ onCreateClick }: { onCreateClick: () => void }) => (
	<div className="p-12 flex flex-col items-center text-center gap-3">
		<div className="h-12 w-12 rounded-xl bg-muted/30 flex items-center justify-center">
			<Tag className="h-5 w-5 text-muted-foreground" />
		</div>
		<h3 className="text-base font-semibold">No label-sync rules yet</h3>
		<p className="text-sm text-muted-foreground max-w-sm">
			Create a rule to mirror a tag to a Sonarr, Radarr, Plex, or Jellyfin destination. Emby is
			available as a source.
		</p>
		<Button onClick={onCreateClick} variant="secondary" className="mt-2">
			<Plus className="h-4 w-4 mr-2" /> Create your first rule
		</Button>
	</div>
);

const RuleTable = ({
	rules,
	runningId,
	recoveryUnavailable,
	incognitoMode,
	onEdit,
	onDelete,
	onRun,
}: {
	rules: LabelSyncRule[];
	runningId: string | null;
	recoveryUnavailable?: boolean;
	incognitoMode: boolean;
	onEdit: (rule: LabelSyncRule) => void;
	onDelete: (rule: LabelSyncRule) => void;
	onRun: (rule: LabelSyncRule) => void;
}) => (
	<div className="min-w-0">
		<table className="block w-full table-fixed text-sm md:table">
			<thead className="hidden border-b border-border/50 md:table-header-group">
				<tr className="text-left text-xs font-medium text-muted-foreground uppercase tracking-wide">
					<th className="px-4 py-3">Name</th>
					<th className="px-4 py-3">Source</th>
					<th className="px-4 py-3">Destination</th>
					<th className="px-4 py-3">Mapping</th>
					<th className="px-4 py-3">Status</th>
					<th className="px-4 py-3">Last Run</th>
					<th className="px-4 py-3 text-right">Actions</th>
				</tr>
			</thead>
			<tbody className="block divide-y divide-border/30 md:table-row-group">
				{rules.map((rule) => (
					<tr
						key={rule.id}
						className="block break-words hover:bg-muted/10 transition-colors md:table-row"
					>
						<td className="block px-4 py-3 md:table-cell">
							<div className="flex items-center gap-2">
								{rule.enabled ? (
									<CheckCircle2 className="h-3.5 w-3.5 shrink-0 text-emerald-500" />
								) : (
									<XCircle className="h-3.5 w-3.5 shrink-0 text-muted-foreground/40" />
								)}
								<span className="font-medium">
									{incognitoMode ? getLinuxSectionName(rule.name) : rule.name}
								</span>
							</div>
						</td>
						<td className="block px-4 py-3 text-muted-foreground md:table-cell">
							<span className="mr-2 font-medium md:hidden">Source:</span>
							<span>{SERVICE_LABEL_BY_VALUE[rule.sourceService] ?? rule.sourceService}</span>
							{rule.sourceInstanceId ? (
								<span className="text-xs ml-1">(instance)</span>
							) : (
								<span className="text-xs text-muted-foreground/60 ml-1">(all instances)</span>
							)}
						</td>
						<td className="block px-4 py-3 text-muted-foreground md:table-cell">
							<span className="mr-2 font-medium md:hidden">Destination:</span>
							<span>{SERVICE_LABEL_BY_VALUE[rule.destService] ?? rule.destService}</span>
						</td>
						<td className="block px-4 py-3 font-mono text-xs md:table-cell">
							<span className="text-muted-foreground">
								{incognitoMode ? getLinuxSectionName(rule.sourceTagName) : rule.sourceTagName}
							</span>
							<span className="text-muted-foreground/50 mx-1.5">→</span>
							<span>
								{incognitoMode ? getLinuxSectionName(rule.destTagName) : rule.destTagName}
							</span>
						</td>
						<td className="block px-4 py-3 md:table-cell">
							{!rule.destinationMutationCapability.supported ? (
								<span
									className="text-xs font-medium px-2 py-0.5 rounded-full bg-amber-500/10 text-amber-500"
									title={rule.destinationMutationCapability.message}
								>
									Mutation unavailable
								</span>
							) : null}
							{recoveryUnavailable ||
							!rule.recovery ||
							rule.recovery.availability === "unavailable" ||
							rule.recovery.state !== "clear" ? (
								<RecoveryStatus recovery={recoveryUnavailable ? undefined : rule.recovery} />
							) : !rule.destinationMutationCapability.supported ? null : rule.lastRunStatus ? (
								<span className={statusClass(rule.lastRunStatus)}>{rule.lastRunStatus}</span>
							) : (
								<span className="text-muted-foreground/50 text-xs">never run</span>
							)}
							{(rule.lastRunStatus === "failed" || rule.lastRunStatus === "partial") &&
							(recoveryUnavailable ||
								!rule.recovery ||
								rule.recovery.availability === "unavailable" ||
								rule.recovery.state !== "clear") ? (
								<span className={`mt-2 block ${statusClass(rule.lastRunStatus)}`}>
									Last run: {rule.lastRunStatus}
								</span>
							) : null}
						</td>
						<td className="block px-4 py-3 text-xs text-muted-foreground md:table-cell">
							<span className="mr-2 font-medium md:hidden">Historical last run:</span>
							{rule.lastRunAt ? new Date(rule.lastRunAt).toLocaleString() : "—"}
						</td>
						<td className="block px-4 py-3 md:table-cell md:text-right">
							<div className="inline-flex gap-1">
								<button
									type="button"
									onClick={() => onRun(rule)}
									disabled={
										runningId === rule.id ||
										!rule.enabled ||
										!rule.destinationMutationCapability.supported
									}
									className="p-1.5 rounded-md hover:bg-muted/30 transition-colors disabled:opacity-30 disabled:cursor-not-allowed"
									aria-label={
										!rule.destinationMutationCapability.supported
											? "Run rule unavailable"
											: "Run rule now"
									}
									title={
										!rule.destinationMutationCapability.supported
											? rule.destinationMutationCapability.message
											: rule.enabled
												? "Run rule now"
												: "Enable the rule to run it"
									}
								>
									<Play
										className={`h-3.5 w-3.5 text-muted-foreground ${runningId === rule.id ? "animate-pulse" : ""}`}
									/>
								</button>
								<button
									type="button"
									onClick={() => onEdit(rule)}
									aria-label="Edit rule"
									disabled={
										recoveryUnavailable ||
										!rule.recovery ||
										rule.recovery.availability === "unavailable" ||
										rule.recovery.state === "restored-held"
									}
									className="p-1.5 rounded-md hover:bg-muted/30 transition-colors"
									title="Edit rule"
								>
									<Pencil className="h-3.5 w-3.5 text-muted-foreground" />
								</button>
								<button
									type="button"
									onClick={() => onDelete(rule)}
									aria-label="Delete rule"
									disabled={
										recoveryUnavailable ||
										!rule.recovery ||
										rule.recovery.availability === "unavailable" ||
										rule.recovery.state === "restored-held"
									}
									className="p-1.5 rounded-md hover:bg-red-500/10 transition-colors"
									title="Delete rule"
								>
									<Trash2 className="h-3.5 w-3.5 text-red-500/70" />
								</button>
							</div>
						</td>
					</tr>
				))}
			</tbody>
		</table>
	</div>
);

function statusClass(status: string): string {
	const base = "text-xs font-medium px-2 py-0.5 rounded-full";
	switch (status) {
		case "success":
			return `${base} bg-emerald-500/10 text-emerald-500`;
		case "partial":
			return `${base} bg-amber-500/10 text-amber-500`;
		case "failed":
			return `${base} bg-red-500/10 text-red-500`;
		default:
			return `${base} bg-muted/30 text-muted-foreground`;
	}
}
