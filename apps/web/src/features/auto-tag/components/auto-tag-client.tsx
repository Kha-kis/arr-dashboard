"use client";

import type { AutoTagRule } from "@arr/shared";
import { CheckCircle2, Pencil, Play, Plus, Tag, Trash2, XCircle } from "lucide-react";
import { useState } from "react";
import { GlassmorphicCard, PageLayout } from "../../../components/layout";
import { Button } from "../../../components/ui/button";
import {
	useAutoTagRules,
	useDeleteAutoTagRule,
	useRunAutoTagRule,
} from "../../../hooks/api/useAutoTag";
import { useThemeGradient } from "../../../hooks/useThemeGradient";
import { RuleDialog } from "./rule-dialog";
import { WebhookConfigPanel } from "./webhook-config-panel";

export const AutoTagClient = () => {
	const { gradient } = useThemeGradient();
	const { data: rules = [], isLoading } = useAutoTagRules();
	const deleteMutation = useDeleteAutoTagRule();
	const runMutation = useRunAutoTagRule();
	const [runningId, setRunningId] = useState<string | null>(null);

	const [dialogOpen, setDialogOpen] = useState(false);
	const [editingRule, setEditingRule] = useState<AutoTagRule | null>(null);

	const openCreate = () => {
		setEditingRule(null);
		setDialogOpen(true);
	};

	const openEdit = (rule: AutoTagRule) => {
		setEditingRule(rule);
		setDialogOpen(true);
	};

	const handleDelete = async (rule: AutoTagRule) => {
		if (!confirm(`Delete rule "${rule.name}"? This cannot be undone.`)) return;
		await deleteMutation.mutateAsync(rule.id);
	};

	const handleRun = async (rule: AutoTagRule) => {
		if (!rule.enabled) {
			alert("Rule is disabled. Enable it before running.");
			return;
		}
		setRunningId(rule.id);
		try {
			const updated = await runMutation.mutateAsync(rule.id);
			alert(`${updated.lastRunStatus?.toUpperCase() ?? "DONE"}\n\n${updated.lastRunMessage ?? ""}`);
		} catch (err) {
			alert(`Run failed: ${err instanceof Error ? err.message : String(err)}`);
		} finally {
			setRunningId(null);
		}
	};

	return (
		<PageLayout>
			<div className="space-y-6 animate-in fade-in duration-300">
				<header className="flex items-start justify-between gap-4">
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
								Auto-Tagger
							</span>
						</h1>
						<p className="text-muted-foreground max-w-xl">
							Apply tags to Sonarr/Radarr items automatically based on criteria — genre, year,
							codec, watch state, and more. Pair with Label Sync to mirror the tag onto Plex,
							Jellyfin, or Emby labels.
						</p>
					</div>
					<Button onClick={openCreate} className="shrink-0">
						<Plus className="h-4 w-4 mr-2" /> New Rule
					</Button>
				</header>

				<WebhookConfigPanel />

				<GlassmorphicCard>
					{isLoading ? (
						<div className="p-6 text-sm text-muted-foreground">Loading rules…</div>
					) : rules.length === 0 ? (
						<EmptyState onCreateClick={openCreate} />
					) : (
						<RuleTable
							rules={rules}
							runningId={runningId}
							onEdit={openEdit}
							onDelete={handleDelete}
							onRun={handleRun}
						/>
					)}
				</GlassmorphicCard>
			</div>

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
		<h3 className="text-base font-semibold">No auto-tag rules yet</h3>
		<p className="text-sm text-muted-foreground max-w-sm">
			Create a rule to tag items by criteria &mdash; e.g., {"“"}tag movies with genre Family as kids
			{"”"} or {"“"}tag any 4K release as premium.{"”"} Useful for kid-safe collections,
			premium-quality flagging, or any criteria-based labeling workflow.
		</p>
		<Button onClick={onCreateClick} variant="secondary" className="mt-2">
			<Plus className="h-4 w-4 mr-2" /> Create your first rule
		</Button>
	</div>
);

const RuleTable = ({
	rules,
	runningId,
	onEdit,
	onDelete,
	onRun,
}: {
	rules: AutoTagRule[];
	runningId: string | null;
	onEdit: (rule: AutoTagRule) => void;
	onDelete: (rule: AutoTagRule) => void;
	onRun: (rule: AutoTagRule) => void;
}) => (
	<div className="overflow-x-auto">
		<table className="w-full text-sm">
			<thead className="border-b border-border/50">
				<tr className="text-left text-xs font-medium text-muted-foreground uppercase tracking-wide">
					<th className="px-4 py-3">Name</th>
					<th className="px-4 py-3">Tag</th>
					<th className="px-4 py-3">Criteria</th>
					<th className="px-4 py-3">Status</th>
					<th className="px-4 py-3">Last Run</th>
					<th className="px-4 py-3 text-right">Actions</th>
				</tr>
			</thead>
			<tbody className="divide-y divide-border/30">
				{rules.map((rule) => (
					<tr key={rule.id} className="hover:bg-muted/10 transition-colors">
						<td className="px-4 py-3">
							<div className="flex items-center gap-2">
								{rule.enabled ? (
									<CheckCircle2 className="h-3.5 w-3.5 shrink-0 text-emerald-500" />
								) : (
									<XCircle className="h-3.5 w-3.5 shrink-0 text-muted-foreground/40" />
								)}
								<span className="font-medium">{rule.name}</span>
							</div>
						</td>
						<td className="px-4 py-3 font-mono text-xs">{rule.tagName}</td>
						<td className="px-4 py-3 text-muted-foreground text-xs">
							{rule.ruleType === "composite" && rule.operator ? (
								<span>
									<span className="font-medium">{rule.operator}</span> of{" "}
									{rule.conditions?.length ?? 0} conditions
								</span>
							) : (
								<span className="capitalize">{rule.ruleType.replace(/_/g, " ")}</span>
							)}
						</td>
						<td className="px-4 py-3">
							{rule.lastRunStatus ? (
								<span className={statusClass(rule.lastRunStatus)}>{rule.lastRunStatus}</span>
							) : (
								<span className="text-muted-foreground/50 text-xs">never run</span>
							)}
						</td>
						<td className="px-4 py-3 text-xs text-muted-foreground">
							{rule.lastRunAt ? new Date(rule.lastRunAt).toLocaleString() : "—"}
						</td>
						<td className="px-4 py-3 text-right">
							<div className="inline-flex gap-1">
								<button
									type="button"
									onClick={() => onRun(rule)}
									disabled={runningId === rule.id || !rule.enabled}
									className="p-1.5 rounded-md hover:bg-muted/30 transition-colors disabled:opacity-30 disabled:cursor-not-allowed"
									title={rule.enabled ? "Run rule now" : "Enable the rule to run it"}
								>
									<Play
										className={`h-3.5 w-3.5 text-muted-foreground ${runningId === rule.id ? "animate-pulse" : ""}`}
									/>
								</button>
								<button
									type="button"
									onClick={() => onEdit(rule)}
									className="p-1.5 rounded-md hover:bg-muted/30 transition-colors"
									title="Edit rule"
								>
									<Pencil className="h-3.5 w-3.5 text-muted-foreground" />
								</button>
								<button
									type="button"
									onClick={() => onDelete(rule)}
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
