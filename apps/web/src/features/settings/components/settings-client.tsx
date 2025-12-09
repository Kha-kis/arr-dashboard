"use client";

import { useMemo, useState, useCallback, useRef } from "react";
import type { CurrentUser } from "@arr/shared";
import { useServicesQuery } from "../../../hooks/api/useServicesQuery";
import { useTagsQuery } from "../../../hooks/api/useTags";
import { useDiscoverOptionsQuery, useDiscoverTestOptionsQuery } from "../../../hooks/api/useDiscover";
import { useCurrentUser } from "../../../hooks/api/useAuth";
import { cn } from "../../../lib/utils";
import { TABS, type TabType } from "../lib/settings-constants";
import {
	useServiceFormState,
	useServicesManagement,
	useTagsManagement,
	useAccountManagement,
} from "../hooks";
import { ServicesTab } from "./services-tab";
import { ServiceForm } from "./service-form";
import { ServiceDefaultsSection } from "./service-defaults-section";
import { TagsTab } from "./tags-tab";
import { AccountTab } from "./account-tab";
import { OIDCProviderSection } from "./oidc-provider-section";
import { PasskeySection } from "./passkey-section";
import { PasswordSection } from "./password-section";
import { BackupTab } from "./backup-tab";
import { SystemTab } from "./system-tab";

/**
 * Main settings client component
 *
 * This component orchestrates the settings view by:
 * - Managing tab state
 * - Fetching and providing data via custom hooks
 * - Delegating rendering to tab-specific components
 * - Coordinating between service form and service list
 *
 * The component maintains minimal local state (active tab)
 * while delegating most logic to custom hooks and child components.
 */
export const SettingsClient = () => {
	// Data queries
	const { data: services = [], isLoading: servicesLoading } = useServicesQuery();
	const { data: tags = [] } = useTagsQuery();
	const { data: currentUser } = useCurrentUser();

	// Local state
	const [activeTab, setActiveTab] = useState<TabType>("services");
	const tabRefs = useRef<Record<TabType, HTMLButtonElement | null>>({
		services: null,
		tags: null,
		account: null,
		authentication: null,
		backup: null,
		system: null,
	});

	// Keyboard navigation handler for tabs
	const handleTabKeyDown = useCallback(
		(event: React.KeyboardEvent<HTMLButtonElement>, currentTab: TabType) => {
			const currentIndex = TABS.indexOf(currentTab);
			let newIndex: number | null = null;

			if (event.key === "ArrowRight") {
				newIndex = (currentIndex + 1) % TABS.length;
			} else if (event.key === "ArrowLeft") {
				newIndex = (currentIndex - 1 + TABS.length) % TABS.length;
			} else if (event.key === "Home") {
				newIndex = 0;
			} else if (event.key === "End") {
				newIndex = TABS.length - 1;
			}

			if (newIndex !== null && newIndex >= 0 && newIndex < TABS.length) {
				event.preventDefault();
				const newTab = TABS[newIndex] as TabType;
				setActiveTab(newTab);
				tabRefs.current[newTab]?.focus();
			}
		},
		[],
	);

	// Custom hooks
	const serviceFormState = useServiceFormState();
	const servicesManagement = useServicesManagement();
	const tagsManagement = useTagsManagement();
	const accountManagement = useAccountManagement(currentUser);

	// Available tags for autocomplete
	const availableTags = useMemo(() => tags.map((tag) => tag.name), [tags]);

	// Check if editing service supports defaults (not prowlarr)
	const editingSupportsDefaults = Boolean(
		serviceFormState.selectedServiceForEdit &&
			serviceFormState.selectedServiceForEdit.service !== "prowlarr",
	);

	// Type guard for services that support defaults (radarr and sonarr only)
	const isDefaultsSupportedService = (
		service: string,
	): service is "radarr" | "sonarr" => {
		return service === "radarr" || service === "sonarr";
	};

	// Check if creating new service supports defaults (radarr or sonarr only)
	const creatingSupportsDefaults = Boolean(
		!serviceFormState.selectedServiceForEdit &&
			isDefaultsSupportedService(serviceFormState.formState.service) &&
			serviceFormState.formState.baseUrl &&
			serviceFormState.formState.apiKey,
	);

	// Fetch instance options for default settings (editing existing)
	const {
		data: instanceOptions,
		isLoading: instanceOptionsLoading,
		isFetching: instanceOptionsFetching,
		isError: instanceOptionsError,
	} = useDiscoverOptionsQuery(
		editingSupportsDefaults ? (serviceFormState.selectedServiceForEdit?.id ?? null) : null,
		serviceFormState.selectedServiceForEdit?.service === "sonarr" ? "series" : "movie",
		editingSupportsDefaults,
	);

	// Fetch test options for default settings (creating new)
	// Note: creatingSupportsDefaults already validates service is "radarr" | "sonarr"
	// via the isDefaultsSupportedService type guard, making the assertion safe
	const serviceForTestQuery = isDefaultsSupportedService(
		serviceFormState.formState.service,
	)
		? serviceFormState.formState.service
		: null;

	const {
		data: testOptions,
		isLoading: testOptionsLoading,
		isFetching: testOptionsFetching,
		isError: testOptionsError,
	} = useDiscoverTestOptionsQuery(
		creatingSupportsDefaults && serviceForTestQuery
			? {
					baseUrl: serviceFormState.formState.baseUrl,
					apiKey: serviceFormState.formState.apiKey,
					service: serviceForTestQuery,
				}
			: null,
		creatingSupportsDefaults,
	);

	// Combine options from both sources
	const optionsPending = editingSupportsDefaults
		? instanceOptionsLoading || instanceOptionsFetching
		: creatingSupportsDefaults
			? testOptionsLoading || testOptionsFetching
			: false;

	const optionsData = editingSupportsDefaults ? (instanceOptions ?? null) : (testOptions ?? null);

	const optionsLoadFailed = Boolean(
		(editingSupportsDefaults && !optionsPending && (instanceOptionsError || !instanceOptions)) ||
			(creatingSupportsDefaults && !optionsPending && (testOptionsError || !testOptions)),
	);

	// Build default section content for service form
	const defaultSectionContent = (
		<ServiceDefaultsSection
			selectedService={serviceFormState.selectedServiceForEdit}
			formState={serviceFormState.formState}
			onFormStateChange={serviceFormState.setFormState}
			optionsPending={optionsPending}
			optionsLoadFailed={optionsLoadFailed}
			optionsData={optionsData}
		/>
	);

	// Handler for service form submission
	const handleServiceFormSubmit = async (event: React.FormEvent<HTMLFormElement>) => {
		event.preventDefault();
		servicesManagement.resetFormTestResult();
		await servicesManagement.handleSubmit(
			serviceFormState.formState,
			serviceFormState.selectedServiceForEdit,
			serviceFormState.resetForm,
		);
	};

	// Handler for service deletion
	const handleDeleteService = (
		instance: Parameters<typeof servicesManagement.handleDeleteService>[0],
	) => {
		void servicesManagement.handleDeleteService(
			instance,
			serviceFormState.selectedServiceForEdit,
			serviceFormState.resetForm,
		);
	};

	return (
		<section className="flex flex-col gap-8">
			{/* Tab navigation */}
			<nav className="flex items-center gap-4 border-b border-border pb-4" role="tablist">
				{TABS.map((tab) => (
					<button
						key={tab}
						ref={(el) => { tabRefs.current[tab] = el; }}
						id={`settings-tab-${tab}`}
						type="button"
						role="tab"
						aria-selected={activeTab === tab ? "true" : "false"}
						aria-controls={`settings-panel-${tab}`}
						tabIndex={activeTab === tab ? 0 : -1}
						onClick={() => setActiveTab(tab)}
						onKeyDown={(e) => handleTabKeyDown(e, tab)}
						className={cn(
							"px-3 py-2 text-sm font-medium uppercase tracking-wide transition",
							activeTab === tab
								? "border-b-2 border-primary text-fg"
								: "text-fg-muted hover:text-fg",
						)}
					>
						{tab}
					</button>
				))}
			</nav>

			{/* Services tab */}
			{activeTab === "services" && (
				<div
					role="tabpanel"
					id="settings-panel-services"
					aria-labelledby="settings-tab-services"
					className="grid gap-6 xl:grid-cols-[2fr,1fr]"
				>
					<ServicesTab
						services={services}
						isLoading={servicesLoading}
						onTestConnection={servicesManagement.handleTestConnection}
						onEdit={serviceFormState.handleEdit}
						onToggleDefault={servicesManagement.toggleDefault}
						onToggleEnabled={servicesManagement.toggleEnabled}
						onDelete={handleDeleteService}
						testingConnection={servicesManagement.testingConnection}
						testResult={servicesManagement.testResult}
						mutationPending={servicesManagement.updateServiceMutation.isPending}
					/>

					<ServiceForm
						formState={serviceFormState.formState}
						onFormStateChange={serviceFormState.setFormState}
						onSubmit={handleServiceFormSubmit}
						onCancel={() => serviceFormState.resetForm(serviceFormState.formState.service)}
						onTestConnection={() =>
							servicesManagement.handleTestFormConnection(serviceFormState.formState)
						}
						selectedService={serviceFormState.selectedServiceForEdit}
						availableTags={availableTags}
						isCreating={servicesManagement.createServiceMutation.isPending}
						isUpdating={servicesManagement.updateServiceMutation.isPending}
						isTesting={servicesManagement.testingFormConnection}
						testResult={servicesManagement.formTestResult}
						defaultSectionContent={defaultSectionContent}
					/>
				</div>
			)}

			{/* Tags tab */}
			{activeTab === "tags" && (
				<div
					role="tabpanel"
					id="settings-panel-tags"
					aria-labelledby="settings-tab-tags"
				>
					<TagsTab
						tags={tags}
						newTagName={tagsManagement.newTagName}
						onNewTagNameChange={tagsManagement.setNewTagName}
						onCreateTag={tagsManagement.handleCreateTag}
						onDeleteTag={(id) => tagsManagement.deleteTagMutation.mutate(id)}
						isCreatingTag={tagsManagement.createTagMutation.isPending}
						isDeletingTag={tagsManagement.deleteTagMutation.isPending}
					/>
				</div>
			)}

			{/* Account tab */}
			{activeTab === "account" && (
				<div
					role="tabpanel"
					id="settings-panel-account"
					aria-labelledby="settings-tab-account"
				>
					<AccountTab
						currentUser={currentUser}
						accountForm={accountManagement.accountForm}
						onAccountFormChange={accountManagement.setAccountForm}
						onAccountUpdate={accountManagement.handleAccountUpdate}
						isUpdating={accountManagement.updateAccountMutation.isPending}
						updateResult={accountManagement.accountUpdateResult}
					/>
				</div>
			)}

			{/* Authentication tab */}
			{activeTab === "authentication" && (
				<div
					role="tabpanel"
					id="settings-panel-authentication"
					aria-labelledby="settings-tab-authentication"
					className="space-y-6"
				>
					<PasswordSection currentUser={currentUser} />
					<PasskeySection />
					<OIDCProviderSection />
				</div>
			)}

			{/* Backup tab */}
			{activeTab === "backup" && (
				<div
					role="tabpanel"
					id="settings-panel-backup"
					aria-labelledby="settings-tab-backup"
				>
					<BackupTab />
				</div>
			)}

			{/* System tab */}
			{activeTab === "system" && (
				<div
					role="tabpanel"
					id="settings-panel-system"
					aria-labelledby="settings-tab-system"
				>
					<SystemTab />
				</div>
			)}
		</section>
	);
};
