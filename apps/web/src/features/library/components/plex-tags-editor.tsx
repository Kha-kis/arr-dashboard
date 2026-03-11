"use client";

/**
 * Plex Tags Editor
 *
 * Inline editor for Plex collections and labels on library items.
 * Displays current tags as badges with add/remove capability.
 */

import type { PlexTagUpdateRequest } from "@arr/shared";
import { Plus, Tag, X } from "lucide-react";
import { useCallback, useState } from "react";
import { useThemeGradient } from "../../../hooks/useThemeGradient";
import { usePlexTagMutation } from "../../../hooks/api/usePlex";

// ============================================================================
// Tag Badge Component
// ============================================================================

interface TagBadgeProps {
	name: string;
	type: "collection" | "label";
	onRemove?: () => void;
	color: string;
}

const TagBadge = ({ name, type, onRemove, color }: TagBadgeProps) => (
	<span
		className="inline-flex items-center gap-1 rounded-full px-2.5 py-0.5 text-xs font-medium border transition-colors"
		style={{
			backgroundColor: `${color}10`,
			borderColor: `${color}30`,
			color,
		}}
	>
		<Tag className="h-3 w-3" />
		{name}
		{onRemove && (
			<button
				type="button"
				onClick={(e) => {
					e.stopPropagation();
					onRemove();
				}}
				className="ml-0.5 rounded-full p-0.5 hover:bg-white/10 transition-colors"
				title={`Remove ${type}: ${name}`}
			>
				<X className="h-3 w-3" />
			</button>
		)}
	</span>
);

// ============================================================================
// Add Tag Inline Input
// ============================================================================

interface AddTagInputProps {
	type: "collection" | "label";
	onAdd: (name: string) => void;
	color: string;
}

const AddTagInput = ({ type, onAdd, color }: AddTagInputProps) => {
	const [isEditing, setIsEditing] = useState(false);
	const [value, setValue] = useState("");

	const handleSubmit = () => {
		const trimmed = value.trim();
		if (trimmed) {
			onAdd(trimmed);
		}
		setValue("");
		setIsEditing(false);
	};

	if (!isEditing) {
		return (
			<button
				type="button"
				onClick={() => setIsEditing(true)}
				className="inline-flex items-center gap-1 rounded-full px-2 py-0.5 text-xs text-muted-foreground border border-dashed border-border/50 hover:border-border hover:text-foreground transition-colors"
			>
				<Plus className="h-3 w-3" />
				{type}
			</button>
		);
	}

	return (
		<input
			type="text"
			value={value}
			onChange={(e) => setValue(e.target.value)}
			onKeyDown={(e) => {
				if (e.key === "Enter") handleSubmit();
				if (e.key === "Escape") {
					setValue("");
					setIsEditing(false);
				}
			}}
			onBlur={handleSubmit}
			placeholder={`Add ${type}...`}
			className="rounded-full px-2.5 py-0.5 text-xs border bg-transparent focus:outline-none w-28"
			style={{ borderColor: `${color}50` }}
			autoFocus
		/>
	);
};

// ============================================================================
// Main Editor
// ============================================================================

interface PlexTagsEditorProps {
	instanceId: string;
	ratingKey: string;
	collections?: string[];
	labels?: string[];
	readOnly?: boolean;
}

export const PlexTagsEditor = ({
	instanceId,
	ratingKey,
	collections = [],
	labels = [],
	readOnly = false,
}: PlexTagsEditorProps) => {
	const { gradient } = useThemeGradient();
	const tagMutation = usePlexTagMutation();

	const handleTagAction = useCallback(
		(type: "collection" | "label", action: "add" | "remove", name: string) => {
			tagMutation.mutate({
				instanceId,
				ratingKey,
				update: { type, action, name },
			});
		},
		[instanceId, ratingKey, tagMutation],
	);

	const hasAnyTags = collections.length > 0 || labels.length > 0;

	if (!hasAnyTags && readOnly) return null;

	return (
		<div className="flex flex-wrap gap-1.5 items-center">
			{/* Collections */}
			{collections.map((name) => (
				<TagBadge
					key={`c:${name}`}
					name={name}
					type="collection"
					color={gradient.from}
					onRemove={readOnly ? undefined : () => handleTagAction("collection", "remove", name)}
				/>
			))}

			{/* Labels */}
			{labels.map((name) => (
				<TagBadge
					key={`l:${name}`}
					name={name}
					type="label"
					color={gradient.to}
					onRemove={readOnly ? undefined : () => handleTagAction("label", "remove", name)}
				/>
			))}

			{/* Add buttons */}
			{!readOnly && (
				<>
					<AddTagInput
						type="collection"
						onAdd={(name) => handleTagAction("collection", "add", name)}
						color={gradient.from}
					/>
					<AddTagInput
						type="label"
						onAdd={(name) => handleTagAction("label", "add", name)}
						color={gradient.to}
					/>
				</>
			)}
		</div>
	);
};
