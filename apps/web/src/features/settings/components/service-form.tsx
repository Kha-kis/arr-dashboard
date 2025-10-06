"use client";

import type { ReactNode } from "react";
import type { ServiceInstanceSummary } from "@arr/shared";
import type { ServiceFormState } from "../lib/settings-utils";
import { Button } from "../../../components/ui/button";
import { Input } from "../../../components/ui/input";
import {
  Card,
  CardContent,
  CardHeader,
  CardTitle,
  CardDescription,
} from "../../../components/ui/card";
import { Alert, AlertDescription } from "../../../components/ui";
import { cn } from "../../../lib/utils";
import {
  SERVICE_TYPES,
  SELECT_CLASS,
  OPTION_STYLE,
} from "../lib/settings-constants";

/**
 * Props for the ServiceForm component
 */
interface ServiceFormProps {
  /** Current form state */
  formState: ServiceFormState;
  /** Handler for form state changes */
  onFormStateChange: (
    updater: (prev: ServiceFormState) => ServiceFormState,
  ) => void;
  /** Handler for form submission */
  onSubmit: (event: React.FormEvent<HTMLFormElement>) => void;
  /** Handler for cancel button */
  onCancel: () => void;
  /** Handler for test connection button */
  onTestConnection: () => void;
  /** The service being edited (null if adding new) */
  selectedService: ServiceInstanceSummary | null;
  /** Available tags for autocomplete */
  availableTags: string[];
  /** Whether creation is pending */
  isCreating: boolean;
  /** Whether update is pending */
  isUpdating: boolean;
  /** Whether connection test is pending */
  isTesting: boolean;
  /** Connection test result */
  testResult?: {
    success: boolean;
    message: string;
  } | null;
  /** Content for the default settings section */
  defaultSectionContent: ReactNode;
}

/**
 * Form for adding or editing service instances
 */
export const ServiceForm = ({
  formState,
  onFormStateChange,
  onSubmit,
  onCancel,
  onTestConnection,
  selectedService,
  availableTags,
  isCreating,
  isUpdating,
  isTesting,
  testResult,
  defaultSectionContent,
}: ServiceFormProps) => {
  return (
    <Card>
      <CardHeader>
        <CardTitle>
          {selectedService ? "Edit Service" : "Add Service"}
        </CardTitle>
        <CardDescription>
          {selectedService
            ? "Update connection details. Leave API key empty to keep the current key."
            : "Provide the base URL and API key for the instance."}
        </CardDescription>
      </CardHeader>
      <CardContent>
        <form className="space-y-4" onSubmit={onSubmit}>
          <div className="space-y-2">
            <label className="text-xs uppercase text-white/60">Service</label>
            <div className="flex gap-2">
              {SERVICE_TYPES.map((service) => (
                <button
                  key={service}
                  type="button"
                  onClick={() =>
                    onFormStateChange((prev) => ({
                      ...prev,
                      service,
                      defaultQualityProfileId: "",
                      defaultLanguageProfileId: "",
                      defaultRootFolderPath: "",
                      defaultSeasonFolder: "",
                    }))
                  }
                  className={cn(
                    "flex-1 rounded-lg border px-3 py-2 text-sm capitalize transition",
                    formState.service === service
                      ? "border-sky-400 bg-sky-500/20 text-white"
                      : "border-white/10 bg-white/5 text-white/60 hover:text-white",
                  )}
                >
                  {service}
                </button>
              ))}
            </div>
          </div>
          <div className="space-y-2">
            <label className="text-xs uppercase text-white/60">Label</label>
            <Input
              value={formState.label}
              onChange={(event) =>
                onFormStateChange((prev) => ({
                  ...prev,
                  label: event.target.value,
                }))
              }
              placeholder="Primary Sonarr"
              required
            />
          </div>
          <div className="space-y-2">
            <label className="text-xs uppercase text-white/60">Base URL</label>
            <Input
              type="url"
              value={formState.baseUrl}
              onChange={(event) =>
                onFormStateChange((prev) => ({
                  ...prev,
                  baseUrl: event.target.value,
                }))
              }
              placeholder="http://localhost:8989"
              required
            />
          </div>
          <div className="space-y-2">
            <label className="text-xs uppercase text-white/60">API Key</label>
            <Input
              type="password"
              value={formState.apiKey}
              onChange={(event) =>
                onFormStateChange((prev) => ({
                  ...prev,
                  apiKey: event.target.value,
                }))
              }
              placeholder={
                selectedService
                  ? "Leave blank to keep current key"
                  : "Your API key"
              }
              required={!selectedService}
            />
          </div>
          <div className="space-y-2">
            <Button
              type="button"
              variant="secondary"
              onClick={onTestConnection}
              disabled={
                isTesting || !formState.baseUrl || !formState.apiKey
              }
            >
              {isTesting ? "Testing connection..." : "Test connection"}
            </Button>
            {testResult && (
              <Alert variant={testResult.success ? "success" : "danger"}>
                <AlertDescription>{testResult.message}</AlertDescription>
              </Alert>
            )}
          </div>
          <div className="space-y-2">
            <label className="text-xs uppercase text-white/60">Tags</label>
            <Input
              value={formState.tags}
              onChange={(event) =>
                onFormStateChange((prev) => ({
                  ...prev,
                  tags: event.target.value,
                }))
              }
              placeholder="Comma separated"
              list="available-tags"
            />
            <datalist id="available-tags">
              {availableTags.map((tag) => (
                <option key={tag} value={tag} />
              ))}
            </datalist>
          </div>
          {formState.service !== "prowlarr" && (
            <div className="space-y-3 rounded-xl border border-white/10 bg-white/5 p-4">
              <div className="flex flex-col gap-1 sm:flex-row sm:items-center sm:justify-between">
                <p className="text-xs uppercase tracking-widest text-white/40">
                  Default add settings
                </p>
                {selectedService ? (
                  <span className="text-xs text-white/50">
                    Applied when using Discover and library tools.
                  </span>
                ) : (
                  <span className="text-xs text-white/40">
                    Save the service before configuring defaults.
                  </span>
                )}
              </div>
              {defaultSectionContent}
            </div>
          )}
          <div className="flex items-center gap-3">
            <label className="flex items-center gap-2 text-sm text-white/70">
              <input
                type="checkbox"
                className="h-4 w-4 border border-white/20 bg-white/10"
                checked={formState.enabled}
                onChange={(event) =>
                  onFormStateChange((prev) => ({
                    ...prev,
                    enabled: event.target.checked,
                  }))
                }
              />
              Enabled
            </label>
            <label className="flex items-center gap-2 text-sm text-white/70">
              <input
                type="checkbox"
                className="h-4 w-4 border border-white/20 bg-white/10"
                checked={formState.isDefault}
                onChange={(event) =>
                  onFormStateChange((prev) => ({
                    ...prev,
                    isDefault: event.target.checked,
                  }))
                }
              />
              Default
            </label>
          </div>
          <div className="flex gap-2">
            <Button type="submit" disabled={isCreating || isUpdating}>
              {selectedService ? "Save changes" : "Add service"}
            </Button>
            {selectedService && (
              <Button
                type="button"
                variant="ghost"
                onClick={onCancel}
                disabled={isUpdating}
              >
                Cancel
              </Button>
            )}
          </div>
        </form>
      </CardContent>
    </Card>
  );
};
