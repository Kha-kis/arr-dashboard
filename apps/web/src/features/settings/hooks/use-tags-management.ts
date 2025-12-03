import { useState } from "react";
import { useCreateTagMutation, useDeleteTagMutation } from "../../../hooks/api/useTags";

/**
 * Hook for managing tags
 */
export const useTagsManagement = () => {
	const createTagMutation = useCreateTagMutation();
	const deleteTagMutation = useDeleteTagMutation();

	const [newTagName, setNewTagName] = useState("");

	const handleCreateTag = async (event: React.FormEvent<HTMLFormElement>) => {
		event.preventDefault();
		if (!newTagName.trim()) {
			return;
		}
		await createTagMutation.mutateAsync(newTagName.trim());
		setNewTagName("");
	};

	return {
		newTagName,
		setNewTagName,
		handleCreateTag,
		createTagMutation,
		deleteTagMutation,
	};
};
