'use client';

import { useMemo, useState, type ReactNode } from "react";
import { useServicesQuery } from "../../../hooks/api/useServicesQuery";
import {
  useCreateServiceMutation,
  useDeleteServiceMutation,
  useUpdateServiceMutation,
} from "../../../hooks/api/useServiceMutations";
import { useTagsQuery, useCreateTagMutation, useDeleteTagMutation } from "../../../hooks/api/useTags";
import { useDiscoverOptionsQuery } from "../../../hooks/api/useDiscover";
import { useCurrentUser, useUpdateAccountMutation } from "../../../hooks/api/useAuth";
import type { ServiceInstanceSummary } from "@arr/shared";
import type { UpdateServicePayload } from "../../../lib/api-client/services";
import { testServiceConnection, testConnectionBeforeAdd } from "../../../lib/api-client/services";
import { Button } from "../../../components/ui/button";
import { Input } from "../../../components/ui/input";
import { Card, CardContent, CardHeader, CardTitle, CardDescription } from "../../../components/ui/card";
import { cn } from "../../../lib/utils";

type ServiceFormState = {
  label: string;
  baseUrl: string;
  apiKey: string;
  service: "sonarr" | "radarr" | "prowlarr";
  enabled: boolean;
  isDefault: boolean;
  tags: string;
  defaultQualityProfileId: string;
  defaultLanguageProfileId: string;
  defaultRootFolderPath: string;
  defaultSeasonFolder: "" | "true" | "false";
};

const defaultFormState = (service: ServiceFormState["service"]): ServiceFormState => ({
  label: "",
  baseUrl: "",
  apiKey: "",
  service,
  enabled: true,
  isDefault: false,
  tags: "",
  defaultQualityProfileId: "",
  defaultLanguageProfileId: "",
  defaultRootFolderPath: "",
  defaultSeasonFolder: "",
});

const SERVICE_TYPES: ServiceFormState["service"][] = ["sonarr", "radarr", "prowlarr"];

const SELECT_CLASS = "w-full rounded-lg border border-white/15 bg-slate-950/80 px-3 py-2 text-sm text-white hover:border-sky-500/60 focus:border-sky-500 focus:outline-none focus:ring-2 focus:ring-sky-400 focus:ring-offset-2 focus:ring-offset-slate-950";
const OPTION_STYLE = { backgroundColor: "rgba(2, 6, 23, 0.92)", color: "#f1f5f9" } as const;

const parseNumericValue = (value: string): number | null => {
  if (!value || value.trim() === "") {
    return null;
  }
  const parsed = Number(value);
  return Number.isNaN(parsed) ? null : parsed;
};

const parseSeasonFolderValue = (value: ServiceFormState["defaultSeasonFolder"]): boolean | null => {
  if (value === "") {
    return null;
  }
  return value === "true";
};

export const SettingsClient = () => {
  const { data: services = [], isLoading: servicesLoading } = useServicesQuery();
  const { data: tags = [] } = useTagsQuery();
  const { data: currentUser } = useCurrentUser();

  const createServiceMutation = useCreateServiceMutation();
  const updateServiceMutation = useUpdateServiceMutation();
  const deleteServiceMutation = useDeleteServiceMutation();
  const createTagMutation = useCreateTagMutation();
  const deleteTagMutation = useDeleteTagMutation();
  const updateAccountMutation = useUpdateAccountMutation();

  const [activeTab, setActiveTab] = useState<"services" | "tags" | "account">("services");
  const [selectedServiceForEdit, setSelectedServiceForEdit] = useState<ServiceInstanceSummary | null>(null);
  const [formState, setFormState] = useState<ServiceFormState>(defaultFormState("sonarr"));
  const [newTagName, setNewTagName] = useState("");
  const [testingConnection, setTestingConnection] = useState<string | null>(null);
  const [testResult, setTestResult] = useState<{ id: string; success: boolean; message: string } | null>(null);
  const [testingFormConnection, setTestingFormConnection] = useState(false);
  const [formTestResult, setFormTestResult] = useState<{ success: boolean; message: string } | null>(null);

  // Account settings state
  const [accountForm, setAccountForm] = useState({
    email: "",
    username: "",
    currentPassword: "",
    newPassword: "",
    confirmPassword: "",
  });
  const [accountUpdateResult, setAccountUpdateResult] = useState<{ success: boolean; message: string } | null>(null);

  const availableTags = useMemo(() => tags.map((tag) => tag.name), [tags]);

  const editingSupportsDefaults = Boolean(
    selectedServiceForEdit && selectedServiceForEdit.service !== "prowlarr",
  );
  const {
    data: instanceOptions,
    isLoading: optionsLoading,
    isFetching: optionsFetching,
    isError: optionsError,
  } = useDiscoverOptionsQuery(
    editingSupportsDefaults ? selectedServiceForEdit?.id ?? null : null,
    selectedServiceForEdit?.service === "sonarr" ? "series" : "movie",
    editingSupportsDefaults,
  );
  const optionsPending = optionsLoading || optionsFetching;
  const optionsData = instanceOptions ?? null;
  const optionsLoadFailed = Boolean(
    editingSupportsDefaults && !optionsPending && (optionsError || !optionsData),
  );

  let defaultSectionContent: ReactNode = null;

  if (selectedServiceForEdit) {
    if (optionsPending) {
      defaultSectionContent = (
        <p className="text-sm text-white/60">Fetching available quality profiles...</p>
      );
    } else if (optionsLoadFailed) {
      defaultSectionContent = (
        <p className="text-sm text-amber-300">
          Unable to load instance options. Verify the connection details and API key.
        </p>
      );
    } else if (optionsData) {
      const hasQualityProfiles = optionsData.qualityProfiles.length > 0;
      const hasRootFolders = optionsData.rootFolders.length > 0;
      const hasLanguageProfiles =
        Array.isArray(optionsData.languageProfiles) && optionsData.languageProfiles.length > 0;

      defaultSectionContent = (
        <>
          <div className="grid gap-3 sm:grid-cols-2">
            <div className="space-y-2">
              <label className="text-xs uppercase text-white/60">Quality profile</label>
              <select
                className={SELECT_CLASS}
                value={formState.defaultQualityProfileId}
                onChange={(event) =>
                  setFormState((prev) => ({ ...prev, defaultQualityProfileId: event.target.value }))
                }
                disabled={!hasQualityProfiles}
              >
                <option value="" style={OPTION_STYLE}>Use instance default</option>
                {optionsData.qualityProfiles.map((profile) => (
                  <option key={profile.id} value={profile.id} style={OPTION_STYLE}>
                    {profile.name}
                  </option>
                ))}
              </select>
              {!hasQualityProfiles && (
                <p className="text-xs text-amber-300">No quality profiles available.</p>
              )}
            </div>
            <div className="space-y-2">
              <label className="text-xs uppercase text-white/60">Root folder</label>
              <select
                className={SELECT_CLASS}
                value={formState.defaultRootFolderPath}
                onChange={(event) =>
                  setFormState((prev) => ({ ...prev, defaultRootFolderPath: event.target.value }))
                }
                disabled={!hasRootFolders}
              >
                <option value="" style={OPTION_STYLE}>Use instance default</option>
                {optionsData.rootFolders.map((folder) => (
                  <option key={folder.path} value={folder.path} style={OPTION_STYLE}>
                    {folder.path}
                  </option>
                ))}
              </select>
              {!hasRootFolders && (
                <p className="text-xs text-amber-300">No root folders configured.</p>
              )}
            </div>
          </div>
          {formState.service === "sonarr" && (
            <div className="grid gap-3 sm:grid-cols-2">
              <div className="space-y-2">
                <label className="text-xs uppercase text-white/60">Language profile</label>
                <select
                  className={SELECT_CLASS}
                  value={formState.defaultLanguageProfileId}
                  onChange={(event) =>
                    setFormState((prev) => ({ ...prev, defaultLanguageProfileId: event.target.value }))
                  }
                  disabled={!hasLanguageProfiles}
                >
                  <option value="" style={OPTION_STYLE}>Use instance default</option>
                  {optionsData.languageProfiles?.map((profile) => (
                    <option key={profile.id} value={profile.id} style={OPTION_STYLE}>
                      {profile.name}
                    </option>
                  ))}
                </select>
                {!hasLanguageProfiles && (
                  <p className="text-xs text-amber-300">No language profiles available.</p>
                )}
              </div>
              <div className="space-y-2">
                <label className="text-xs uppercase text-white/60">Season folders</label>
                <select
                  className={SELECT_CLASS}
                  value={formState.defaultSeasonFolder}
                  onChange={(event) =>
                    setFormState((prev) => ({
                      ...prev,
                      defaultSeasonFolder: event.target.value as ServiceFormState["defaultSeasonFolder"],
                    }))
                  }
                >
                  <option value="" style={OPTION_STYLE}>Use instance default</option>
                  <option value="true" style={OPTION_STYLE}>Create season folders</option>
                  <option value="false" style={OPTION_STYLE}>Keep all episodes together</option>
                </select>
              </div>
            </div>
          )}
        </>
      );
    }
  }

  const resetForm = (service: ServiceFormState["service"]) => {
    setFormState(defaultFormState(service));
    setSelectedServiceForEdit(null);
    setFormTestResult(null);
  };

  const handleSubmit = async (event: React.FormEvent<HTMLFormElement>) => {
    event.preventDefault();

    const trimmedTags = formState.tags
      .split(",")
      .map((tag) => tag.trim())
      .filter(Boolean);

    const defaultQualityProfileId = parseNumericValue(formState.defaultQualityProfileId);
    const defaultLanguageProfileId =
      formState.service === "sonarr" ? parseNumericValue(formState.defaultLanguageProfileId) : null;
    const trimmedRootFolder = formState.defaultRootFolderPath.trim();
    const defaultRootFolderPath =
      formState.service !== "prowlarr" && trimmedRootFolder.length > 0 ? trimmedRootFolder : null;
    const defaultSeasonFolder =
      formState.service === "sonarr" ? parseSeasonFolderValue(formState.defaultSeasonFolder) : null;

    const basePayload = {
      label: formState.label.trim(),
      baseUrl: formState.baseUrl.trim(),
      apiKey: formState.apiKey.trim(),
      service: formState.service,
      enabled: formState.enabled,
      isDefault: formState.isDefault,
      tags: trimmedTags,
      defaultQualityProfileId,
      defaultLanguageProfileId,
      defaultRootFolderPath,
      defaultSeasonFolder,
    };

    if (!basePayload.label || !basePayload.baseUrl || (!selectedServiceForEdit && !basePayload.apiKey)) {
      return;
    }

    if (selectedServiceForEdit) {
      const updatePayload: UpdateServicePayload = { ...basePayload };
      if (!basePayload.apiKey) {
        updatePayload.apiKey = undefined;
      }

      await updateServiceMutation.mutateAsync({
        id: selectedServiceForEdit.id,
        payload: updatePayload,
      });
    } else {
      await createServiceMutation.mutateAsync(basePayload);
    }

    resetForm(basePayload.service);
  };

  const handleEdit = (service: ServiceInstanceSummary) => {
    setSelectedServiceForEdit(service);
    setFormState({
      label: service.label,
      baseUrl: service.baseUrl,
      apiKey: "",
      service: service.service,
      enabled: service.enabled,
      isDefault: service.isDefault,
      tags: service.tags.map((tag) => tag.name).join(", "),
      defaultQualityProfileId: service.defaultQualityProfileId != null ? String(service.defaultQualityProfileId) : "",
      defaultLanguageProfileId: service.defaultLanguageProfileId != null ? String(service.defaultLanguageProfileId) : "",
      defaultRootFolderPath: service.defaultRootFolderPath ?? "",
      defaultSeasonFolder:
        service.defaultSeasonFolder === null || service.defaultSeasonFolder === undefined
          ? ""
          : service.defaultSeasonFolder
            ? "true"
            : "false",
    });
  };

  const handleDeleteService = async (instance: ServiceInstanceSummary) => {
    await deleteServiceMutation.mutateAsync(instance.id);
    if (selectedServiceForEdit?.id === instance.id) {
      resetForm(instance.service);
    }
  };

  const toggleDefault = async (instance: ServiceInstanceSummary) => {
    await updateServiceMutation.mutateAsync({
      id: instance.id,
      payload: {
        service: instance.service,
        isDefault: !instance.isDefault,
      },
    });
  };

  const toggleEnabled = async (instance: ServiceInstanceSummary) => {
    await updateServiceMutation.mutateAsync({
      id: instance.id,
      payload: {
        enabled: !instance.enabled,
      },
    });
  };

  const handleCreateTag = async (event: React.FormEvent<HTMLFormElement>) => {
    event.preventDefault();
    if (!newTagName.trim()) {
      return;
    }
    await createTagMutation.mutateAsync(newTagName.trim());
    setNewTagName("");
  };

  const handleTestConnection = async (instance: ServiceInstanceSummary) => {
    setTestingConnection(instance.id);
    setTestResult(null);

    try {
      const result = await testServiceConnection(instance.id);

      if (result.success) {
        setTestResult({
          id: instance.id,
          success: true,
          message: `${result.message} (v${result.version})`,
        });
      } else {
        setTestResult({
          id: instance.id,
          success: false,
          message: `${result.error}: ${result.details}`,
        });
      }
    } catch (error: any) {
      setTestResult({
        id: instance.id,
        success: false,
        message: error.message ?? "Connection test failed",
      });
    } finally {
      setTestingConnection(null);
    }
  };

  const handleTestFormConnection = async () => {
    if (!formState.baseUrl || !formState.apiKey) {
      setFormTestResult({
        success: false,
        message: "Base URL and API Key are required to test connection",
      });
      return;
    }

    setTestingFormConnection(true);
    setFormTestResult(null);

    try {
      const result = await testConnectionBeforeAdd(
        formState.baseUrl.trim(),
        formState.apiKey.trim(),
        formState.service
      );

      if (result.success) {
        setFormTestResult({
          success: true,
          message: `${result.message} (v${result.version})`,
        });
      } else {
        setFormTestResult({
          success: false,
          message: `${result.error}: ${result.details}`,
        });
      }
    } catch (error: any) {
      setFormTestResult({
        success: false,
        message: error.message ?? "Connection test failed",
      });
    } finally {
      setTestingFormConnection(false);
    }
  };

  const handleAccountUpdate = async (event: React.FormEvent<HTMLFormElement>) => {
    event.preventDefault();
    setAccountUpdateResult(null);

    // Validate password fields if updating password
    if (accountForm.newPassword || accountForm.confirmPassword || accountForm.currentPassword) {
      if (!accountForm.currentPassword) {
        setAccountUpdateResult({
          success: false,
          message: "Current password is required to change password",
        });
        return;
      }
      if (!accountForm.newPassword) {
        setAccountUpdateResult({
          success: false,
          message: "New password is required",
        });
        return;
      }
      if (accountForm.newPassword !== accountForm.confirmPassword) {
        setAccountUpdateResult({
          success: false,
          message: "New passwords do not match",
        });
        return;
      }
      if (accountForm.newPassword.length < 8) {
        setAccountUpdateResult({
          success: false,
          message: "Password must be at least 8 characters",
        });
        return;
      }
      if (!/[a-z]/.test(accountForm.newPassword)) {
        setAccountUpdateResult({
          success: false,
          message: "Password must contain at least one lowercase letter",
        });
        return;
      }
      if (!/[A-Z]/.test(accountForm.newPassword)) {
        setAccountUpdateResult({
          success: false,
          message: "Password must contain at least one uppercase letter",
        });
        return;
      }
      if (!/[0-9]/.test(accountForm.newPassword)) {
        setAccountUpdateResult({
          success: false,
          message: "Password must contain at least one number",
        });
        return;
      }
      if (!/[^a-zA-Z0-9]/.test(accountForm.newPassword)) {
        setAccountUpdateResult({
          success: false,
          message: "Password must contain at least one special character",
        });
        return;
      }
    }

    // Build update payload
    const payload: any = {};
    if (accountForm.email && accountForm.email !== currentUser?.email) {
      payload.email = accountForm.email;
    }
    if (accountForm.username && accountForm.username !== currentUser?.username) {
      payload.username = accountForm.username;
    }
    if (accountForm.newPassword && accountForm.currentPassword) {
      payload.currentPassword = accountForm.currentPassword;
      payload.newPassword = accountForm.newPassword;
    }

    if (Object.keys(payload).length === 0) {
      setAccountUpdateResult({
        success: false,
        message: "No changes to save",
      });
      return;
    }

    try {
      await updateAccountMutation.mutateAsync(payload);
      setAccountUpdateResult({
        success: true,
        message: "Account updated successfully",
      });
      // Clear password fields
      setAccountForm(prev => ({
        ...prev,
        currentPassword: "",
        newPassword: "",
        confirmPassword: "",
      }));
    } catch (error: any) {
      setAccountUpdateResult({
        success: false,
        message: error.message ?? "Failed to update account",
      });
    }
  };

  return (
    <section className="flex flex-col gap-8">
      <div className="flex items-center gap-4 border-b border-white/10 pb-4">
        {(["services", "tags", "account"] as const).map((tab) => (
          <button
            key={tab}
            type="button"
            onClick={() => setActiveTab(tab)}
            className={cn(
              "px-3 py-2 text-sm font-medium uppercase tracking-wide transition",
              activeTab === tab ? "border-b-2 border-sky-400 text-white" : "text-white/50 hover:text-white",
            )}
          >
            {tab}
          </button>
        ))}
      </div>

      {activeTab === "services" && (
        <div className="grid gap-6 xl:grid-cols-[2fr,1fr]">
          <Card>
            <CardHeader>
              <CardTitle>Configured Instances</CardTitle>
              <CardDescription>Manage all Sonarr, Radarr, and Prowlarr connections</CardDescription>
            </CardHeader>
            <CardContent className="space-y-4">
              {servicesLoading ? (
                <p className="text-sm text-white/60">Loading services...</p>
              ) : services.length === 0 ? (
                <p className="text-sm text-white/60">No services configured yet.</p>
              ) : (
                <div className="space-y-3">
                  {services.map((instance) => (
                    <div
                      key={instance.id}
                      className="flex flex-col gap-2 rounded-lg border border-white/10 bg-white/5 p-4"
                    >
                      <div className="flex flex-col gap-2 md:flex-row md:items-center md:justify-between">
                        <div>
                          <div className="flex items-center gap-3">
                            <span className="rounded-md bg-white/10 px-2 py-1 text-xs uppercase text-white/60">
                              {instance.service}
                            </span>
                            <h3 className="text-base font-semibold text-white">{instance.label}</h3>
                          </div>
                          <p className="text-xs text-white/50">{instance.baseUrl}</p>
                          <p className="text-xs text-white/50">
                            Tags: {instance.tags.length === 0 ? "-" : instance.tags.map((tag) => tag.name).join(", ")}
                          </p>
                        </div>
                        <div className="flex flex-wrap gap-2">
                          <Button
                            variant="secondary"
                            onClick={() => void handleTestConnection(instance)}
                            disabled={testingConnection === instance.id}
                          >
                            {testingConnection === instance.id ? "Testing..." : "Test"}
                          </Button>
                          <Button variant="secondary" onClick={() => handleEdit(instance)}>
                            Edit
                          </Button>
                          <Button
                            variant={instance.isDefault ? "secondary" : "ghost"}
                            onClick={() => void toggleDefault(instance)}
                            disabled={updateServiceMutation.isPending}
                          >
                            {instance.isDefault ? "Default" : "Make default"}
                          </Button>
                          <Button
                            variant="ghost"
                            onClick={() => void toggleEnabled(instance)}
                            disabled={updateServiceMutation.isPending}
                          >
                            {instance.enabled ? "Disable" : "Enable"}
                          </Button>
                          <Button
                            variant="danger"
                            onClick={() => void handleDeleteService(instance)}
                            disabled={deleteServiceMutation.isPending}
                          >
                            Delete
                          </Button>
                        </div>
                      </div>
                      {testResult && testResult.id === instance.id && (
                        <div className={cn(
                          "rounded-md px-3 py-2 text-sm",
                          testResult.success
                            ? "bg-green-500/10 text-green-300 border border-green-500/30"
                            : "bg-red-500/10 text-red-300 border border-red-500/30"
                        )}>
                          {testResult.message}
                        </div>
                      )}
                    </div>
                  ))}
                </div>
              )}
            </CardContent>
          </Card>

          <Card>
            <CardHeader>
              <CardTitle>{selectedServiceForEdit ? "Edit Service" : "Add Service"}</CardTitle>
              <CardDescription>
                {selectedServiceForEdit
                  ? "Update connection details. Leave API key empty to keep the current key."
                  : "Provide the base URL and API key for the instance."}
              </CardDescription>
            </CardHeader>
            <CardContent>
              <form className="space-y-4" onSubmit={handleSubmit}>
                <div className="space-y-2">
                  <label className="text-xs uppercase text-white/60">Service</label>
                  <div className="flex gap-2">
                    {SERVICE_TYPES.map((service) => (
                      <button
                        key={service}
                        type="button"
                        onClick={() =>
                          setFormState((prev) => ({
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
                    onChange={(event) => setFormState((prev) => ({ ...prev, label: event.target.value }))}
                    placeholder="Primary Sonarr"
                    required
                  />
                </div>
                <div className="space-y-2">
                  <label className="text-xs uppercase text-white/60">Base URL</label>
                  <Input
                    type="url"
                    value={formState.baseUrl}
                    onChange={(event) => setFormState((prev) => ({ ...prev, baseUrl: event.target.value }))}
                    placeholder="http://localhost:8989"
                    required
                  />
                </div>
                <div className="space-y-2">
                  <label className="text-xs uppercase text-white/60">API Key</label>
                  <Input
                    type="password"
                    value={formState.apiKey}
                    onChange={(event) => setFormState((prev) => ({ ...prev, apiKey: event.target.value }))}
                    placeholder={selectedServiceForEdit ? "Leave blank to keep current key" : "Your API key"}
                    required={!selectedServiceForEdit}
                  />
                </div>
                <div className="space-y-2">
                  <Button
                    type="button"
                    variant="secondary"
                    onClick={handleTestFormConnection}
                    disabled={testingFormConnection || !formState.baseUrl || !formState.apiKey}
                  >
                    {testingFormConnection ? "Testing connection..." : "Test connection"}
                  </Button>
                  {formTestResult && (
                    <div className={cn(
                      "rounded-md px-3 py-2 text-sm",
                      formTestResult.success
                        ? "bg-green-500/10 text-green-300 border border-green-500/30"
                        : "bg-red-500/10 text-red-300 border border-red-500/30"
                    )}>
                      {formTestResult.message}
                    </div>
                  )}
                </div>
                <div className="space-y-2">
                  <label className="text-xs uppercase text-white/60">Tags</label>
                  <Input
                    value={formState.tags}
                    onChange={(event) => setFormState((prev) => ({ ...prev, tags: event.target.value }))}
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
                      <p className="text-xs uppercase tracking-widest text-white/40">Default add settings</p>
                      {selectedServiceForEdit ? (
                        optionsPending ? (
                          <span className="text-xs text-white/60">Loading instance options...</span>
                        ) : (
                          <span className="text-xs text-white/50">Applied when using Discover and library tools.</span>
                        )
                      ) : (
                        <span className="text-xs text-white/40">Save the service before configuring defaults.</span>
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
                      onChange={(event) => setFormState((prev) => ({ ...prev, enabled: event.target.checked }))}
                    />
                    Enabled
                  </label>
                  <label className="flex items-center gap-2 text-sm text-white/70">
                    <input
                      type="checkbox"
                      className="h-4 w-4 border border-white/20 bg-white/10"
                      checked={formState.isDefault}
                      onChange={(event) => setFormState((prev) => ({ ...prev, isDefault: event.target.checked }))}
                    />
                    Default
                  </label>
                </div>
                <div className="flex gap-2">
                  <Button
                    type="submit"
                    disabled={createServiceMutation.isPending || updateServiceMutation.isPending}
                  >
                    {selectedServiceForEdit ? "Save changes" : "Add service"}
                  </Button>
                  {selectedServiceForEdit && (
                    <Button
                      type="button"
                      variant="ghost"
                      onClick={() => resetForm(formState.service)}
                      disabled={updateServiceMutation.isPending}
                    >
                      Cancel
                    </Button>
                  )}
                </div>
              </form>
            </CardContent>
          </Card>
        </div>
      )}

      {activeTab === "tags" && (
        <div className="grid gap-6 md:grid-cols-[1fr,2fr]">
          <Card>
            <CardHeader>
              <CardTitle>Create Tag</CardTitle>
              <CardDescription>Organize instances by environment, location, or owner.</CardDescription>
            </CardHeader>
            <CardContent>
              <form className="space-y-4" onSubmit={handleCreateTag}>
                <div className="space-y-2">
                  <label className="text-xs uppercase text-white/60">Name</label>
                  <Input
                    value={newTagName}
                    onChange={(event) => setNewTagName(event.target.value)}
                    placeholder="Production"
                    required
                  />
                </div>
                <div className="flex gap-2">
                  <Button type="submit" disabled={createTagMutation.isPending}>
                    Add tag
                  </Button>
                </div>
              </form>
            </CardContent>
          </Card>

          <Card>
            <CardHeader>
              <CardTitle>Existing Tags</CardTitle>
              <CardDescription>Use tags to filter multi-instance data across the dashboard.</CardDescription>
            </CardHeader>
            <CardContent className="space-y-2">
              {tags.length === 0 ? (
                <p className="text-sm text-white/60">No tags created yet.</p>
              ) : (
                <ul className="space-y-2">
                  {tags.map((tag) => (
                    <li
                      key={tag.id}
                      className="flex items-center justify-between rounded-lg border border-white/10 bg-white/5 px-4 py-2"
                    >
                      <span className="text-sm text-white">{tag.name}</span>
                      <Button
                        variant="ghost"
                        onClick={() => deleteTagMutation.mutate(tag.id)}
                        disabled={deleteTagMutation.isPending}
                      >
                        Remove
                      </Button>
                    </li>
                  ))}
                </ul>
              )}
            </CardContent>
          </Card>
        </div>
      )}

      {activeTab === "account" && (
        <div className="grid gap-6 md:grid-cols-[2fr,1fr]">
          <Card>
            <CardHeader>
              <CardTitle>Account Information</CardTitle>
              <CardDescription>Update your email, username, or password.</CardDescription>
            </CardHeader>
            <CardContent>
              <form className="space-y-4" onSubmit={handleAccountUpdate}>
                <div className="space-y-2">
                  <label className="text-xs uppercase text-white/60">Email</label>
                  <Input
                    type="email"
                    value={accountForm.email}
                    onChange={(event) => setAccountForm(prev => ({ ...prev, email: event.target.value }))}
                    placeholder={currentUser?.email ?? ""}
                  />
                  <p className="text-xs text-white/40">Current: {currentUser?.email}</p>
                </div>
                <div className="space-y-2">
                  <label className="text-xs uppercase text-white/60">Username</label>
                  <Input
                    value={accountForm.username}
                    onChange={(event) => setAccountForm(prev => ({ ...prev, username: event.target.value }))}
                    placeholder={currentUser?.username ?? ""}
                  />
                  <p className="text-xs text-white/40">Current: {currentUser?.username}</p>
                </div>
                <div className="border-t border-white/10 pt-4 mt-6">
                  <h3 className="text-sm font-semibold text-white mb-4">Change Password</h3>
                  <div className="space-y-4">
                    <div className="space-y-2">
                      <label className="text-xs uppercase text-white/60">Current Password</label>
                      <Input
                        type="password"
                        value={accountForm.currentPassword}
                        onChange={(event) => setAccountForm(prev => ({ ...prev, currentPassword: event.target.value }))}
                        placeholder="Enter current password"
                      />
                    </div>
                    <div className="space-y-2">
                      <label className="text-xs uppercase text-white/60">New Password</label>
                      <Input
                        type="password"
                        value={accountForm.newPassword}
                        onChange={(event) => setAccountForm(prev => ({ ...prev, newPassword: event.target.value }))}
                        placeholder="At least 8 characters"
                      />
                      <p className="text-xs text-white/50">
                        Must include uppercase, lowercase, number, and special character
                      </p>
                    </div>
                    <div className="space-y-2">
                      <label className="text-xs uppercase text-white/60">Confirm New Password</label>
                      <Input
                        type="password"
                        value={accountForm.confirmPassword}
                        onChange={(event) => setAccountForm(prev => ({ ...prev, confirmPassword: event.target.value }))}
                        placeholder="Re-enter new password"
                      />
                    </div>
                  </div>
                </div>
                <div className="flex gap-2">
                  <Button type="submit" disabled={updateAccountMutation.isPending}>
                    {updateAccountMutation.isPending ? "Saving..." : "Save changes"}
                  </Button>
                </div>
                {accountUpdateResult && (
                  <div className={cn(
                    "rounded-md px-3 py-2 text-sm",
                    accountUpdateResult.success
                      ? "bg-green-500/10 text-green-300 border border-green-500/30"
                      : "bg-red-500/10 text-red-300 border border-red-500/30"
                  )}>
                    {accountUpdateResult.message}
                  </div>
                )}
              </form>
            </CardContent>
          </Card>

          <Card>
            <CardHeader>
              <CardTitle>Account Details</CardTitle>
              <CardDescription>Your current account information.</CardDescription>
            </CardHeader>
            <CardContent className="space-y-4">
              <div className="space-y-1">
                <p className="text-xs uppercase text-white/60">Role</p>
                <p className="text-sm text-white capitalize">{currentUser?.role.toLowerCase()}</p>
              </div>
              <div className="space-y-1">
                <p className="text-xs uppercase text-white/60">Created</p>
                <p className="text-sm text-white">
                  {currentUser?.createdAt ? new Date(currentUser.createdAt).toLocaleDateString() : "-"}
                </p>
              </div>
            </CardContent>
          </Card>
        </div>
      )}
    </section>
  );
};
