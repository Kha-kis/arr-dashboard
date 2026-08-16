import {
	isKindLegalForContext,
	isRuleNot,
	isRulePredicate,
	ruleParamSchemaMap,
	type RuleDocument,
	type RuleNode,
	validateV1Bounds,
} from "@arr/shared";

export type RuleNodePath = readonly number[];

function formatPath(path: RuleNodePath): string {
	return path.length === 0 ? "root" : `root[${path.join("][")}]`;
}

function assertPath(path: RuleNodePath): void {
	for (const segment of path) {
		if (!Number.isInteger(segment) || segment < 0) {
			throw new TypeError("Rule node path index values must be non-negative integers");
		}
	}
}

function cloneValue(value: unknown, seen = new WeakMap<object, unknown>()): unknown {
	if (value === null || typeof value !== "object") return value;
	const known = seen.get(value);
	if (known) return known;
	if (Array.isArray(value)) {
		const copy: unknown[] = [];
		seen.set(value, copy);
		for (const item of value) copy.push(cloneValue(item, seen));
		return copy;
	}
	const copy: Record<string, unknown> = {};
	seen.set(value, copy);
	for (const [key, item] of Object.entries(value)) copy[key] = cloneValue(item, seen);
	return copy;
}

function cloneRuleNode(node: RuleNode): RuleNode {
	if (isRulePredicate(node)) {
		return {
			kind: node.kind,
			params: cloneValue(node.params) as Record<string, unknown>,
			...(node.unavailableKind === undefined ? {} : { unavailableKind: node.unavailableKind }),
		};
	}
	if (isRuleNot(node)) return { not: cloneRuleNode(node.not) };
	if ("all" in node) return { all: node.all.map(cloneRuleNode) };
	return { any: node.any.map(cloneRuleNode) };
}

function childAt(node: RuleNode, index: number, path: RuleNodePath): RuleNode {
	if (isRulePredicate(node)) {
		throw new Error(`Rule path ${formatPath(path)} cannot continue through a predicate`);
	}
	if (isRuleNot(node)) {
		if (index !== 0)
			throw new RangeError(`Rule path ${formatPath(path)} has no NOT child at index ${index}`);
		return node.not;
	}
	const children = "all" in node ? node.all : node.any;
	const child = children[index];
	if (!child) throw new RangeError(`Rule path ${formatPath(path)} has no child at index ${index}`);
	return child;
}

function replaceRuleNode(
	root: RuleNode,
	path: RuleNodePath,
	updater: (node: RuleNode) => RuleNode,
): RuleNode {
	if (path.length === 0) return updater(cloneRuleNode(root));
	const [index, ...remaining] = path;
	if (index === undefined) throw new Error("Rule path is missing an index");
	const child = childAt(root, index, path);
	const replacement = replaceRuleNode(child, remaining, updater);
	if (isRuleNot(root)) return { not: replacement };
	if (isRulePredicate(root))
		throw new Error(`Rule path ${formatPath(path)} cannot continue through a predicate`);
	if ("all" in root) {
		return { all: root.all.map((item, childIndex) => (childIndex === index ? replacement : item)) };
	}
	return { any: root.any.map((item, childIndex) => (childIndex === index ? replacement : item)) };
}

/** Replace a node at a path without mutating the supplied tree. */
export function updateRuleNode(
	root: RuleNode,
	path: RuleNodePath,
	updater: (node: RuleNode) => RuleNode,
): RuleNode {
	assertPath(path);
	if (typeof updater !== "function") throw new TypeError("Rule node updater must be a function");
	return replaceRuleNode(root, path, updater);
}

/** Append a child to an ALL or ANY node, preserving the existing sibling order. */
export function appendRuleChild(
	root: RuleNode,
	groupPath: RuleNodePath,
	child: RuleNode,
): RuleNode {
	return updateRuleNode(root, groupPath, (group) => {
		if (isRuleNot(group)) throw new Error("Cannot append a child to a NOT node");
		if (isRulePredicate(group))
			throw new Error("Can only append a rule child to an ALL or ANY group");
		if ("all" in group) return { all: [...group.all, cloneRuleNode(child)] };
		return { any: [...group.any, cloneRuleNode(child)] };
	});
}

/** Remove a node by path. Removing the root intentionally returns null. */
export function removeRuleNode(root: RuleNode, path: RuleNodePath): RuleNode | null {
	assertPath(path);
	if (path.length === 0) return null;
	const parentPath = path.slice(0, -1);
	const index = path[path.length - 1];
	if (index === undefined) throw new Error("Rule path is missing an index");
	return updateRuleNode(root, parentPath, (parent) => {
		if (isRuleNot(parent)) throw new Error("Cannot remove the required child of a NOT node");
		if (isRulePredicate(parent)) throw new Error("Cannot remove a child from a predicate");
		if ("all" in parent) {
			if (!parent.all[index])
				throw new RangeError(`Rule path ${formatPath(path)} has no child at index ${index}`);
			return { all: parent.all.filter((_, childIndex) => childIndex !== index) };
		}
		if (!parent.any[index])
			throw new RangeError(`Rule path ${formatPath(path)} has no child at index ${index}`);
		return { any: parent.any.filter((_, childIndex) => childIndex !== index) };
	});
}

/** Deep-copy a cleanup rule document while removing read-only API annotations. */
export function stripCleanupRuleAnnotations(document: RuleDocument): RuleDocument {
	return { version: document.version, root: stripNodeAnnotations(document.root) };
}

function stripNodeAnnotations(node: RuleNode): RuleNode {
	if (isRulePredicate(node))
		return { kind: node.kind, params: cloneValue(node.params) as Record<string, unknown> };
	if (isRuleNot(node)) return { not: stripNodeAnnotations(node.not) };
	if ("all" in node) return { all: node.all.map(stripNodeAnnotations) };
	return { any: node.any.map(stripNodeAnnotations) };
}

/**
 * Validate a cleanup rule for authoring. This is intentionally stricter than
 * the shared structural parser: retired and API-annotated predicates cannot be
 * saved, empty groups cannot be authored, and list membership cannot be
 * negated because its cached membership semantics are one-way.
 */
export function validateCleanupRuleDocument(document: RuleDocument): string | null {
	const boundsError = validateV1Bounds(document);
	if (boundsError) return boundsError;

	const stack: Array<{ node: RuleNode; hasNotAncestor: boolean }> = [
		{ node: document.root, hasNotAncestor: false },
	];
	while (stack.length > 0) {
		const current = stack.pop();
		if (!current) break;
		const { node, hasNotAncestor } = current;
		if (isRulePredicate(node)) {
			if (node.unavailableKind) return `"${node.kind}" is unavailable and must be replaced.`;
			if (!isKindLegalForContext("library-cleanup", node.kind)) {
				return `"${node.kind}" is not available for library cleanup.`;
			}
			if (
				hasNotAncestor &&
				(node.kind === "tmdb_list_member" || node.kind === "trakt_list_member")
			) {
				return "List membership conditions cannot be used inside NOT expressions.";
			}
			const parsed = ruleParamSchemaMap[node.kind]?.safeParse(node.params);
			if (parsed && !parsed.success) {
				const issue = parsed.error.issues[0];
				const where = issue?.path.length ? ` (${issue.path.join(".")})` : "";
				return `${node.kind}: ${issue?.message ?? "invalid parameters"}${where}.`;
			}
			continue;
		}
		if (isRuleNot(node)) {
			stack.push({ node: node.not, hasNotAncestor: true });
			continue;
		}
		const children = "all" in node ? node.all : node.any;
		if (children.length === 0) return "Add at least one condition to every ALL or ANY group.";
		for (let index = children.length - 1; index >= 0; index -= 1) {
			const child = children[index];
			if (child) stack.push({ node: child, hasNotAncestor });
		}
	}

	return null;
}
