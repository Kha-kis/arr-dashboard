"use client";

import { Tags, Plus, Loader2 } from "lucide-react";
import { Button } from "../../../components/ui/button";
import { Input } from "../../../components/ui/input";
import {
	PremiumSection,
	PremiumEmptyState,
	GlassmorphicCard,
} from "../../../components/layout";
import { THEME_GRADIENTS } from "../../../lib/theme-gradients";
import { useColorTheme } from "../../../providers/color-theme-provider";
import { TagListItem } from "./tag-list-item";

/**
 * Props for the TagsTab component
 */
interface TagsTabProps {
	/** List of tags */
	tags: Array<{ id: string; name: string }>;
	/** New tag name input value */
	newTagName: string;
	/** Handler for new tag name change */
	onNewTagNameChange: (value: string) => void;
	/** Handler for create tag form submission */
	onCreateTag: (event: React.FormEvent<HTMLFormElement>) => void;
	/** Handler for delete tag */
	onDeleteTag: (id: string) => void;
	/** Whether tag creation is pending */
	isCreatingTag: boolean;
	/** Whether tag deletion is pending */
	isDeletingTag: boolean;
}

/**
 * Premium Tags Tab
 *
 * Tag management with:
 * - Glassmorphic create form
 * - Theme-aware tag list
 * - Staggered animations
 */
export const TagsTab = ({
	tags,
	newTagName,
	onNewTagNameChange,
	onCreateTag,
	onDeleteTag,
	isCreatingTag,
	isDeletingTag,
}: TagsTabProps) => {
	const { colorTheme } = useColorTheme();
	const themeGradient = THEME_GRADIENTS[colorTheme];

	return (
		<div className="grid gap-6 lg:grid-cols-[1fr,2fr]">
			{/* Create tag form */}
			<GlassmorphicCard padding="lg">
				<div className="space-y-4">
					<div className="flex items-center gap-2">
						<div
							className="flex h-10 w-10 items-center justify-center rounded-xl"
							style={{
								background: `linear-gradient(135deg, ${themeGradient.from}20, ${themeGradient.to}20)`,
								border: `1px solid ${themeGradient.from}30`,
							}}
						>
							<Plus className="h-5 w-5" style={{ color: themeGradient.from }} />
						</div>
						<div>
							<h3 className="font-semibold text-foreground">Create Tag</h3>
							<p className="text-xs text-muted-foreground">Organize instances by environment, location, or owner</p>
						</div>
					</div>

					<form className="space-y-4 pt-2" onSubmit={onCreateTag}>
						<div className="space-y-2">
							<label className="text-xs font-medium uppercase tracking-wide text-muted-foreground">
								Tag Name
							</label>
							<Input
								value={newTagName}
								onChange={(event) => onNewTagNameChange(event.target.value)}
								placeholder="e.g., Production, Home, Testing"
								required
								className="bg-card/30 border-border/50"
							/>
						</div>
						<Button
							type="submit"
							disabled={isCreatingTag || !newTagName.trim()}
							className="w-full gap-2"
							style={{
								background: `linear-gradient(135deg, ${themeGradient.from}, ${themeGradient.to})`,
								boxShadow: `0 4px 12px -4px ${themeGradient.glow}`,
							}}
						>
							{isCreatingTag ? (
								<>
									<Loader2 className="h-4 w-4 animate-spin" />
									Creating...
								</>
							) : (
								<>
									<Plus className="h-4 w-4" />
									Add tag
								</>
							)}
						</Button>
					</form>
				</div>
			</GlassmorphicCard>

			{/* Existing tags */}
			<PremiumSection
				title="Existing Tags"
				description="Use tags to filter multi-instance data across the dashboard"
				icon={Tags}
			>
				{tags.length === 0 ? (
					<PremiumEmptyState
						icon={Tags}
						title="No tags yet"
						description="Create your first tag to organize your service instances."
					/>
				) : (
					<ul className="space-y-3">
						{tags.map((tag, index) => (
							<TagListItem
								key={tag.id}
								id={tag.id}
								name={tag.name}
								onRemove={onDeleteTag}
								isPending={isDeletingTag}
								animationDelay={index * 50}
							/>
						))}
					</ul>
				)}
			</PremiumSection>
		</div>
	);
};
