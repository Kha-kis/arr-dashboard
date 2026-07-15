"use client";

import type { CrossDomainAction, CrossDomainRuleDraft } from "@arr/shared";
import { CONTEXT_KINDS } from "@arr/shared";
import { Loader2, Save } from "lucide-react";
import { useEffect, useMemo, useState } from "react";
import {
	Dialog,
	DialogContent,
	DialogDescription,
	DialogHeader,
	DialogTitle,
} from "@/components/ui/dialog";
import { useIncognitoMode } from "@/contexts/IncognitoContext";
import {
	useCreateCrossDomainRule,
	useCrossDomainRules,
	useUpdateCrossDomainRule,
} from "@/hooks/api/useAutomation";
import { useCleanupFieldOptions } from "@/hooks/api/useLibraryCleanup";
import { useServicesQuery } from "@/hooks/api/useServicesQuery";
import { useThemeGradient } from "@/hooks/useThemeGradient";
import { getErrorMessage } from "@/lib/error-utils";
import { getLinuxInstanceName } from "@/lib/incognito";
import { getInputStyles } from "@/lib/theme-input-styles";
import { getDefaultConditionParams } from "../../rule-criteria/components/condition-params-fields";
import {
	buildCriteriaDocument,
	type CriteriaEditorState,
	decomposeCriteriaDocument,
	validateCriteriaEditor,
} from "../lib/rule-document-editor";
import { CriteriaConditionEditor } from "./criteria-condition-editor";

interface Props {
	open: boolean;
	onOpenChange: (open: boolean) => void;
	editRuleId?: string | null;
}

const freshEditorState = (): CriteriaEditorState => ({
	mode: "single",
	operator: "all",
	conditions: [{ id: "seed-0", kind: "age", params: getDefaultConditionParams("age") }],
});

export function CrossDomainRuleComposerDialog({ open, onOpenChange, editRuleId }: Props) {
	const isEdit = Boolean(editRuleId);
	const [incognito] = useIncognitoMode();
	const { gradient } = useThemeGradient();
	const { data } = useCrossDomainRules();
	const { data: services = [] } = useServicesQuery({ enabled: open });
	const { data: fieldOptions, isLoading: fieldOptionsLoading } = useCleanupFieldOptions();
	const createRule = useCreateCrossDomainRule();
	const updateRule = useUpdateCrossDomainRule();
	const rule = useMemo(
		() => data?.rules.find((candidate) => candidate.id === editRuleId),
		[data, editRuleId],
	);
	const arrServices = services.filter(
		(service) => service.enabled && (service.service === "sonarr" || service.service === "radarr"),
	);
	const editDataReady = !isEdit || Boolean(rule);

	const [name, setName] = useState("");
	const [editor, setEditor] = useState<CriteriaEditorState>(freshEditorState);
	const [serviceTypes, setServiceTypes] = useState<Array<"SONARR" | "RADARR">>([
		"SONARR",
		"RADARR",
	]);
	const [instanceIds, setInstanceIds] = useState<string[]>([]);
	const [applyTag, setApplyTag] = useState(true);
	const [tagName, setTagName] = useState("");
	const [sendNotification, setSendNotification] = useState(true);
	const [exemptCleanup, setExemptCleanup] = useState(false);
	const [error, setError] = useState<string | null>(null);

	useEffect(() => {
		if (!open || !editDataReady) return;
		setError(null);
		if (rule) {
			setName(rule.name);
			setEditor(decomposeCriteriaDocument(rule.document));
			setServiceTypes(
				rule.scope.serviceTypes.length > 0 ? rule.scope.serviceTypes : ["SONARR", "RADARR"],
			);
			setInstanceIds(rule.scope.instanceIds);
			const tagAction = rule.actions.find((action) => action.type === "apply_tag");
			setApplyTag(Boolean(tagAction));
			setTagName(tagAction?.type === "apply_tag" ? tagAction.tagName : "");
			setSendNotification(rule.actions.some((action) => action.type === "send_notification"));
			setExemptCleanup(rule.actions.some((action) => action.type === "exempt_cleanup"));
		} else {
			setName("");
			setEditor(freshEditorState());
			setServiceTypes(["SONARR", "RADARR"]);
			setInstanceIds([]);
			setApplyTag(true);
			setTagName("");
			setSendNotification(true);
			setExemptCleanup(false);
		}
	}, [open, editDataReady, rule]);

	const inputStyles = getInputStyles(gradient);
	const inputClass = `${inputStyles.base} focus:outline-hidden`;
	const labelClass = "mb-1 block text-xs text-muted-foreground";
	const legalKinds = useMemo(() => [...CONTEXT_KINDS["cross-domain"]], []);
	const isSaving = createRule.isPending || updateRule.isPending;

	const toggleValue = <T,>(values: T[], value: T, checked: boolean): T[] =>
		checked ? [...values, value] : values.filter((candidate) => candidate !== value);

	const handleSubmit = async (event: React.FormEvent) => {
		event.preventDefault();
		if (!name.trim()) return setError("Give the rule a name.");
		const documentError = validateCriteriaEditor(editor, "cross-domain");
		if (documentError) return setError(documentError);
		if (serviceTypes.length === 0) return setError("Choose Sonarr, Radarr, or both.");
		const actions: CrossDomainAction[] = [];
		if (applyTag) {
			if (!tagName.trim()) return setError("Enter the tag to apply.");
			actions.push({ type: "apply_tag", tagName: tagName.trim() });
		}
		if (sendNotification) actions.push({ type: "send_notification" });
		if (exemptCleanup) actions.push({ type: "exempt_cleanup" });
		if (actions.length < 2) return setError("Choose at least two actions from different domains.");

		const draft: CrossDomainRuleDraft = {
			name: name.trim(),
			document: buildCriteriaDocument(editor),
			scope: { serviceTypes, instanceIds },
			actions,
		};
		try {
			if (editRuleId) await updateRule.mutateAsync({ id: editRuleId, draft });
			else await createRule.mutateAsync(draft);
			onOpenChange(false);
		} catch (err) {
			setError(getErrorMessage(err, "Could not save the draft."));
		}
	};

	return (
		<Dialog open={open} onOpenChange={onOpenChange}>
			<DialogContent className="max-h-[90vh] max-w-3xl overflow-y-auto">
				<DialogHeader>
					<DialogTitle>{isEdit ? "Edit Cross-Domain Draft" : "New Cross-Domain Rule"}</DialogTitle>
					<DialogDescription>
						Save a draft, preview its current matches, then deploy an atomic active snapshot.
					</DialogDescription>
				</DialogHeader>
				{!editDataReady ? (
					<div className="flex justify-center py-12">
						<Loader2 className="h-5 w-5 animate-spin" />
					</div>
				) : (
					<form onSubmit={handleSubmit} className="space-y-5">
						<label className="block">
							<span className={labelClass}>Rule name</span>
							<input
								value={name}
								onChange={(event) => setName(event.target.value)}
								className={inputClass}
							/>
						</label>

						<div className="space-y-3 rounded-xl border border-border/50 bg-card/30 p-4">
							<span className="text-sm font-medium">Library scope</span>
							<div className="flex gap-4 text-sm">
								{(["SONARR", "RADARR"] as const).map((service) => (
									<label key={service} className="flex items-center gap-2">
										<input
											type="checkbox"
											checked={serviceTypes.includes(service)}
											onChange={(event) =>
												setServiceTypes(toggleValue(serviceTypes, service, event.target.checked))
											}
										/>
										{service === "SONARR" ? "Sonarr" : "Radarr"}
									</label>
								))}
							</div>
							{arrServices.length > 0 && (
								<div>
									<span className={labelClass}>
										Instances (none selected means all chosen services)
									</span>
									<div className="grid gap-2 sm:grid-cols-2">
										{arrServices.map((service) => (
											<label key={service.id} className="flex items-center gap-2 text-sm">
												<input
													type="checkbox"
													checked={instanceIds.includes(service.id)}
													onChange={(event) =>
														setInstanceIds(
															toggleValue(instanceIds, service.id, event.target.checked),
														)
													}
												/>
												{incognito ? getLinuxInstanceName(service.label) : service.label}
											</label>
										))}
									</div>
								</div>
							)}
						</div>

						<div className="space-y-3 rounded-xl border border-border/50 bg-card/30 p-4">
							<span className="text-sm font-medium">Conditions</span>
							<CriteriaConditionEditor
								state={editor}
								onChange={setEditor}
								legalKinds={legalKinds}
								fieldOptions={fieldOptions}
								fieldOptionsLoading={fieldOptionsLoading}
								inputClass={inputClass}
								labelClass={labelClass}
							/>
						</div>

						<div className="space-y-3 rounded-xl border border-border/50 bg-card/30 p-4">
							<div>
								<span className="text-sm font-medium">Actions</span>
								<p className="text-xs text-muted-foreground">Choose at least two domains.</p>
							</div>
							<label className="flex items-center gap-2 text-sm">
								<input
									type="checkbox"
									checked={applyTag}
									onChange={(event) => setApplyTag(event.target.checked)}
								/>
								Apply an *arr tag
							</label>
							{applyTag && (
								<input
									value={tagName}
									onChange={(event) => setTagName(event.target.value)}
									placeholder="Tag name"
									className={inputClass}
								/>
							)}
							<label className="flex items-center gap-2 text-sm">
								<input
									type="checkbox"
									checked={sendNotification}
									onChange={(event) => setSendNotification(event.target.checked)}
								/>
								Send an automation-match notification
							</label>
							{sendNotification && (
								<p className="pl-5 text-xs text-muted-foreground">
									Delivered through enabled channels subscribed to “Automation Rule Matched.”
								</p>
							)}
							<label className="flex items-center gap-2 text-sm">
								<input
									type="checkbox"
									checked={exemptCleanup}
									onChange={(event) => setExemptCleanup(event.target.checked)}
								/>
								Exempt matches from Library Cleanup
							</label>
						</div>

						{rule?.active && (
							<p className="text-xs text-muted-foreground">
								Saving changes updates only the draft. Version {rule.deploymentVersion} stays active
								until you deploy again.
							</p>
						)}
						{error && (
							<div className="rounded-md border border-red-500/20 bg-red-500/10 px-3 py-2 text-xs text-red-400">
								{error}
							</div>
						)}
						<div className="flex justify-end gap-2">
							<button
								type="button"
								onClick={() => onOpenChange(false)}
								className="rounded-lg border border-border/50 px-4 py-2 text-sm"
							>
								Cancel
							</button>
							<button
								type="submit"
								disabled={isSaving}
								className="flex items-center gap-2 rounded-lg px-4 py-2 text-sm font-medium text-white disabled:opacity-60"
								style={{
									background: `linear-gradient(to right, ${gradient.from}, ${gradient.to})`,
								}}
							>
								{isSaving ? (
									<Loader2 className="h-4 w-4 animate-spin" />
								) : (
									<Save className="h-4 w-4" />
								)}
								Save draft
							</button>
						</div>
					</form>
				)}
			</DialogContent>
		</Dialog>
	);
}
