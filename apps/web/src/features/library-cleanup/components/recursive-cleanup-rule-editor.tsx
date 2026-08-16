"use client";

import {
	type CleanupFieldOptionsResponse,
	type CleanupRuleType,
	isRuleNot,
	isRulePredicate,
	type RuleDocument,
	type RuleNode,
} from "@arr/shared";
import { Braces, CirclePlus, GitBranch, Trash2, Undo2 } from "lucide-react";
import {
	ConditionParamsFields,
	getDefaultConditionParams,
} from "../../rule-criteria/components/condition-params-fields";
import {
	appendRuleChild,
	removeRuleNode,
	type RuleNodePath,
	updateRuleNode,
} from "../lib/recursive-rule-editor";
import { RULE_TYPE_MAP, RULE_TYPES } from "./rule-type-catalog";

interface RecursiveCleanupRuleEditorProps {
	document: RuleDocument;
	onChange: (document: RuleDocument) => void;
	fieldOptions: CleanupFieldOptionsResponse | undefined;
	fieldOptionsLoading: boolean;
	inputClass: string;
	labelClass: string;
	error: string | null;
}

function defaultPredicate(): RuleNode {
	return { kind: "age", params: getDefaultConditionParams("age") };
}

export function RecursiveCleanupRuleEditor({
	document,
	onChange,
	fieldOptions,
	fieldOptionsLoading,
	inputClass,
	labelClass,
	error,
}: RecursiveCleanupRuleEditorProps) {
	const changeRoot = (root: RuleNode) => onChange({ version: 1, root });

	const replaceAt = (path: RuleNodePath, replacement: RuleNode) => {
		changeRoot(updateRuleNode(document.root, path, () => replacement));
	};

	const removeAt = (path: RuleNodePath) => {
		const next = removeRuleNode(document.root, path);
		if (next) changeRoot(next);
	};

	const addTo = (path: RuleNodePath, child: RuleNode) => {
		changeRoot(appendRuleChild(document.root, path, child));
	};

	return (
		<div className="space-y-3">
			<div className="rounded-lg border border-border/40 bg-card/20 p-3">
				<p className="text-sm font-medium text-foreground">Nested condition tree</p>
				<p className="mt-1 text-xs text-muted-foreground">
					Combine conditions with ALL, ANY, and NOT. The same tree is used for preview and
					execution.
				</p>
			</div>
			<RuleNodeEditor
				node={document.root}
				path={[]}
				isRoot
				onReplace={replaceAt}
				onRemove={removeAt}
				onAdd={addTo}
				fieldOptions={fieldOptions}
				fieldOptionsLoading={fieldOptionsLoading}
				inputClass={inputClass}
				labelClass={labelClass}
			/>
			{error && (
				<div className="rounded-md border border-destructive/20 bg-destructive/10 px-3 py-2 text-xs text-destructive">
					{error}
				</div>
			)}
		</div>
	);
}

interface RuleNodeEditorProps {
	node: RuleNode;
	path: RuleNodePath;
	isRoot?: boolean;
	canRemove?: boolean;
	onReplace: (path: RuleNodePath, node: RuleNode) => void;
	onRemove: (path: RuleNodePath) => void;
	onAdd: (path: RuleNodePath, node: RuleNode) => void;
	fieldOptions: CleanupFieldOptionsResponse | undefined;
	fieldOptionsLoading: boolean;
	inputClass: string;
	labelClass: string;
}

function RuleNodeEditor(props: RuleNodeEditorProps) {
	const { node, path, isRoot = false, canRemove = true, onReplace, onRemove } = props;

	if (isRulePredicate(node)) {
		const knownKind = RULE_TYPE_MAP.has(node.kind as CleanupRuleType);
		return (
			<div className="space-y-2 rounded-lg border border-border/40 bg-background/40 p-3">
				<div className="flex flex-wrap items-center justify-between gap-2">
					<span className="text-xs font-semibold uppercase tracking-wide text-muted-foreground">
						Condition
					</span>
					<NodeActions {...props} isRoot={isRoot} />
				</div>
				<select
					aria-label="Condition type"
					value={node.kind}
					onChange={(event) => {
						const kind = event.target.value as CleanupRuleType;
						onReplace(path, { kind, params: getDefaultConditionParams(kind) });
					}}
					className={props.inputClass}
				>
					{!knownKind && <option value={node.kind}>Unavailable: {node.kind}</option>}
					{RULE_TYPES.filter((item) => item.value !== "composite").map((item) => (
						<option key={item.value} value={item.value}>
							{item.label}
						</option>
					))}
				</select>
				<p className="text-xs text-muted-foreground">
					{RULE_TYPE_MAP.get(node.kind as CleanupRuleType)?.desc ??
						"This stored condition is unavailable. Choose a supported type before saving."}
				</p>
				{knownKind && (
					<ConditionParamsFields
						ruleType={node.kind as CleanupRuleType}
						params={node.params}
						onParamsChange={(params) => onReplace(path, { kind: node.kind, params })}
						fieldOptions={props.fieldOptions}
						fieldOptionsLoading={props.fieldOptionsLoading}
						inputClass={props.inputClass}
						labelClass={props.labelClass}
					/>
				)}
			</div>
		);
	}

	if (isRuleNot(node)) {
		return (
			<div
				role="group"
				aria-label="NOT group"
				className="space-y-2 rounded-lg border border-amber-500/25 bg-amber-500/5 p-3"
			>
				<div className="flex flex-wrap items-center justify-between gap-2">
					<div>
						<span className="text-xs font-semibold uppercase tracking-wide text-amber-500">
							NOT
						</span>
						<p className="text-xs text-muted-foreground">Invert the child result.</p>
					</div>
					<div className="flex items-center gap-1.5">
						<button
							type="button"
							onClick={() => onReplace(path, node.not)}
							className="inline-flex items-center gap-1 rounded-md border border-border/40 px-2 py-1 text-xs text-muted-foreground hover:text-foreground"
						>
							<Undo2 className="h-3 w-3" aria-hidden="true" /> Remove NOT
						</button>
						{!isRoot && canRemove && (
							<button
								type="button"
								aria-label="Remove node"
								onClick={() => onRemove(path)}
								className="rounded-md p-1 text-muted-foreground hover:text-destructive"
							>
								<Trash2 className="h-3.5 w-3.5" aria-hidden="true" />
							</button>
						)}
					</div>
				</div>
				<div className="border-l border-amber-500/30 pl-3">
					<RuleNodeEditor
						{...props}
						node={node.not}
						path={[...path, 0]}
						isRoot={false}
						canRemove={false}
					/>
				</div>
			</div>
		);
	}

	const isAll = "all" in node;
	const children = isAll ? node.all : node.any;
	const label = isAll ? "ALL" : "ANY";
	return (
		<div
			role="group"
			aria-label={`${label} group`}
			className="space-y-3 rounded-lg border border-primary/20 bg-primary/5 p-3"
		>
			<div className="flex flex-wrap items-start justify-between gap-2">
				<div>
					<div className="flex gap-1.5" aria-label="Group operator">
						{(["ALL", "ANY"] as const).map((operator) => (
							<button
								key={operator}
								type="button"
								aria-pressed={label === operator}
								onClick={() =>
									onReplace(path, operator === "ALL" ? { all: children } : { any: children })
								}
								className={`rounded-md border px-2 py-1 text-xs font-semibold ${
									label === operator
										? "border-primary/30 bg-primary/15 text-primary"
										: "border-border/40 text-muted-foreground"
								}`}
							>
								{operator}
							</button>
						))}
					</div>
					<p className="mt-1 text-xs text-muted-foreground">
						{isAll ? "Every child must match." : "At least one child must match."}
					</p>
				</div>
				<NodeActions {...props} isRoot={isRoot} />
			</div>

			<div className="space-y-2 border-l border-primary/20 pl-3">
				{children.map((child, index) => (
					<RuleNodeEditor
						{...props}
						// biome-ignore lint/suspicious/noArrayIndexKey: paths define stable tree positions
						key={index}
						node={child}
						path={[...path, index]}
						isRoot={false}
						canRemove
					/>
				))}
				{children.length === 0 && (
					<p className="text-xs italic text-destructive">Add at least one child before saving.</p>
				)}
			</div>

			<div className="flex flex-wrap gap-1.5">
				<button
					type="button"
					aria-label={`Add condition to ${label} group`}
					onClick={() => props.onAdd(path, defaultPredicate())}
					className="inline-flex items-center gap-1 rounded-md border border-dashed border-border/50 px-2 py-1 text-xs text-muted-foreground hover:text-foreground"
				>
					<CirclePlus className="h-3 w-3" aria-hidden="true" /> Condition
				</button>
				<button
					type="button"
					aria-label={`Add group to ${label} group`}
					onClick={() => props.onAdd(path, { all: [defaultPredicate()] })}
					className="inline-flex items-center gap-1 rounded-md border border-dashed border-border/50 px-2 py-1 text-xs text-muted-foreground hover:text-foreground"
				>
					<GitBranch className="h-3 w-3" aria-hidden="true" /> Group
				</button>
				<button
					type="button"
					aria-label={`Add NOT to ${label} group`}
					onClick={() => props.onAdd(path, { not: defaultPredicate() })}
					className="inline-flex items-center gap-1 rounded-md border border-dashed border-border/50 px-2 py-1 text-xs text-muted-foreground hover:text-foreground"
				>
					<Braces className="h-3 w-3" aria-hidden="true" /> NOT
				</button>
			</div>
		</div>
	);
}

function NodeActions(props: RuleNodeEditorProps) {
	const { node, path, isRoot = false, canRemove = true, onReplace, onRemove } = props;
	return (
		<div className="flex flex-wrap items-center gap-1.5">
			{isRoot && isRulePredicate(node) && (
				<>
					<button
						type="button"
						aria-label="Wrap root in ALL group"
						onClick={() => onReplace(path, { all: [node] })}
						className="inline-flex items-center gap-1 rounded-md border border-border/40 px-2 py-1 text-xs text-muted-foreground hover:text-foreground"
					>
						<GitBranch className="h-3 w-3" aria-hidden="true" /> Wrap in ALL
					</button>
					<button
						type="button"
						aria-label="Wrap root in ANY group"
						onClick={() => onReplace(path, { any: [node] })}
						className="inline-flex items-center gap-1 rounded-md border border-border/40 px-2 py-1 text-xs text-muted-foreground hover:text-foreground"
					>
						<GitBranch className="h-3 w-3" aria-hidden="true" /> Wrap in ANY
					</button>
				</>
			)}
			<button
				type="button"
				onClick={() => onReplace(path, { not: node })}
				className="rounded-md border border-border/40 px-2 py-1 text-xs text-muted-foreground hover:text-foreground"
			>
				Negate
			</button>
			{!isRoot && canRemove && (
				<button
					type="button"
					aria-label="Remove node"
					onClick={() => onRemove(path)}
					className="rounded-md p-1 text-muted-foreground hover:text-destructive"
				>
					<Trash2 className="h-3.5 w-3.5" aria-hidden="true" />
				</button>
			)}
		</div>
	);
}
