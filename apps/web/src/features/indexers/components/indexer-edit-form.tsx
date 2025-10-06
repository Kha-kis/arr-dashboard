"use client";

import { Input } from "../../../components/ui/input";

/**
 * Form for editing indexer enable status and priority
 * @param formEnable - Current enable status
 * @param formPriority - Current priority value
 * @param onEnableChange - Callback when enable status changes
 * @param onPriorityChange - Callback when priority changes
 * @returns React component displaying edit form
 */
export const IndexerEditForm = ({
  formEnable,
  formPriority,
  onEnableChange,
  onPriorityChange,
}: {
  formEnable: boolean;
  formPriority: number | undefined;
  onEnableChange: (enabled: boolean) => void;
  onPriorityChange: (priority: number | undefined) => void;
}) => {
  return (
    <div className="flex flex-wrap items-center gap-4 text-sm text-white">
      <label className="flex items-center gap-2">
        <input
          type="checkbox"
          className="h-4 w-4 rounded border-white/20 bg-slate-900"
          checked={formEnable}
          onChange={(event) => onEnableChange(event.target.checked)}
        />
        <span>{formEnable ? "Enabled" : "Disabled"}</span>
      </label>
      <div className="flex items-center gap-2">
        <span className="text-xs uppercase tracking-widest text-white/40">
          Priority
        </span>
        <Input
          type="number"
          value={formPriority === undefined ? "" : formPriority.toString()}
          onChange={(event) => {
            const raw = event.target.value;
            if (raw.trim().length === 0) {
              onPriorityChange(undefined);
              return;
            }
            const parsed = Number(raw);
            if (!Number.isNaN(parsed)) {
              onPriorityChange(parsed);
            }
          }}
          className="h-8 w-24 bg-slate-900 text-white"
        />
      </div>
    </div>
  );
};
