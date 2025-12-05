"use client";

import { Button } from "../../../components/ui/button";
import { Input } from "../../../components/ui/input";
import {
	Card,
	CardContent,
	CardHeader,
	CardTitle,
	CardDescription,
} from "../../../components/ui/card";
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
 * Tab for managing tags
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
	return (
		<div className="grid gap-6 md:grid-cols-[1fr,2fr]">
			<Card>
				<CardHeader>
					<CardTitle>Create Tag</CardTitle>
					<CardDescription>Organize instances by environment, location, or owner.</CardDescription>
				</CardHeader>
				<CardContent>
					<form className="space-y-4" onSubmit={onCreateTag}>
						<div className="space-y-2">
							<label className="text-xs uppercase text-fg-muted">Name</label>
							<Input
								value={newTagName}
								onChange={(event) => onNewTagNameChange(event.target.value)}
								placeholder="Production"
								required
							/>
						</div>
						<div className="flex gap-2">
							<Button type="submit" disabled={isCreatingTag}>
								Add tag
							</Button>
						</div>
					</form>
				</CardContent>
			</Card>

			<Card>
				<CardHeader>
					<CardTitle>Existing Tags</CardTitle>
					<CardDescription>
						Use tags to filter multi-instance data across the dashboard.
					</CardDescription>
				</CardHeader>
				<CardContent className="space-y-2">
					{tags.length === 0 ? (
						<p className="text-sm text-fg-muted">No tags created yet.</p>
					) : (
						<ul className="space-y-2">
							{tags.map((tag) => (
								<TagListItem
									key={tag.id}
									id={tag.id}
									name={tag.name}
									onRemove={onDeleteTag}
									isPending={isDeletingTag}
								/>
							))}
						</ul>
					)}
				</CardContent>
			</Card>
		</div>
	);
};
