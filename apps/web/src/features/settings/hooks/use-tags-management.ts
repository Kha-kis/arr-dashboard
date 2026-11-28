import { useState } from "react";
import { useCreateTagMutation, useDeleteTagMutation } from "../../../hooks/api/useTags";

/**
 * Hook for managing tags
 */
export const useTagsManagement = () => {
	const createTagMutation = useCreateTagMutation();
	const deleteTagMutation = useDeleteTagMutation();

	const [newTagName, setNewTagName] = useState("");

	const handleCreateTag = (event: React.FormEvent<HTMLFormElement>) => {
		event.preventDefault();
		const submittedName = newTagName.trim();
		if (!submittedName || createTagMutation.isPending || deleteTagMutation.isPending) {
			return;
		}
		deleteTagMutation.reset();
		createTagMutation.mutate(submittedName, {
			onSuccess: () => {
				setNewTagName((current) => (current.trim() === submittedName ? "" : current));
			},
		});
	};

	const handleDeleteTag = (id: string) => {
		if (createTagMutation.isPending || deleteTagMutation.isPending) return;
		createTagMutation.reset();
		deleteTagMutation.mutate(id);
	};

	return {
		newTagName,
		setNewTagName,
		handleCreateTag,
		handleDeleteTag,
		createTagMutation,
		deleteTagMutation,
	};
};
