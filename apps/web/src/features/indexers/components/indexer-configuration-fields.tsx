"use client";

import type { ProwlarrIndexerField } from "@arr/shared";
import { formatFieldValue, isApiKeyRelatedField } from "../lib/indexers-utils";

/**
 * Displays configuration fields for an indexer (excluding API key fields)
 * @param fields - Array of indexer fields
 * @returns React component displaying configuration fields
 */
export const IndexerConfigurationFields = ({
  fields,
}: {
  fields: ProwlarrIndexerField[];
}) => {
  const filteredFields = fields.filter((field) => !isApiKeyRelatedField(field));

  if (filteredFields.length === 0) {
    return null;
  }

  return (
    <div className="space-y-2">
      <p className="text-xs uppercase tracking-widest text-white/40">
        Configuration
      </p>
      <div className="grid gap-3 sm:grid-cols-2">
        {filteredFields.slice(0, 10).map((field) => (
          <div
            key={field.name}
            className="rounded-lg border border-white/10 bg-white/5 p-3"
          >
            <p className="text-xs uppercase text-white/40">
              {field.label ?? field.name}
            </p>
            <p className="mt-1 text-sm text-white">
              {formatFieldValue(field.name, field.value)}
            </p>
            {field.helpText ? (
              <p className="mt-1 text-xs text-white/40">{field.helpText}</p>
            ) : null}
          </div>
        ))}
      </div>
    </div>
  );
};
