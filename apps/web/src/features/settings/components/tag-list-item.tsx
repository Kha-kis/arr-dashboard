"use client";

import { Button } from "../../../components/ui/button";

/**
 * Props for the TagListItem component
 */
interface TagListItemProps {
  /** Tag ID */
  id: string;
  /** Tag name */
  name: string;
  /** Handler for remove button */
  onRemove: (id: string) => void;
  /** Whether deletion is pending */
  isPending: boolean;
}

/**
 * Displays a single tag list item with remove button
 */
export const TagListItem = ({
  id,
  name,
  onRemove,
  isPending,
}: TagListItemProps) => {
  return (
    <li className="flex items-center justify-between rounded-lg border border-white/10 bg-white/5 px-4 py-2">
      <span className="text-sm text-white">{name}</span>
      <Button variant="ghost" onClick={() => onRemove(id)} disabled={isPending}>
        Remove
      </Button>
    </li>
  );
};
