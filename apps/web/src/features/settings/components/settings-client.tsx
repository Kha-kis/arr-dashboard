"use client";

import { useMemo, useState } from "react";
import {
	Settings,
	Server,
	Tags,
	User,
	Shield,
	Palette,
	Archive,
	Cpu,
} from "lucide-react";
import { useServicesQuery } from "../../../hooks/api/useServicesQuery";
import { useTagsQuery } from "../../../hooks/api/useTags";
import { useDiscoverOptionsQuery, useDiscoverTestOptionsQuery } from "../../../hooks/api/useDiscover";
import { useCurrentUser } from "../../../hooks/api/useAuth";
import {
	PremiumPageHeader,
	PremiumTabs,
	PremiumPageLoading,
	type PremiumTab,
} from "../../../components/layout";
import { useThemeGradient } from "../../../hooks/useThemeGradient";
import { type TabType } from "../lib/settings-constants";
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
import { SessionsSection } from "./sessions-section";
import { AppearanceTab } from "./appearance-tab";
import { BackupTab } from "./backup-tab";
import { SystemTab } from "./system-tab";

/**
 * Premium Settings Client
 *
 * Main orchestrator for the settings feature with:
 * - Premium gradient header
 * - Theme-aware tab navigation
 * - Staggered entrance animations
 */
export const SettingsClient = () => {
	const { gradient: _themeGradient } = useThemeGradient();

	// Data queries
	const { data: services = [], isLoading: servicesLoading } = useServicesQuery();
	const { data: tags = [] } = useTagsQuery();
	const { data: currentUser } = useCurrentUser();

	// Local state
	const [activeTab, setActiveTab] = useState<TabType>("services");

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

	// Tab configuration with icons
	const tabConfig: PremiumTab[] = [
		{ id: "services", label: "Services", icon: Server },
		{ id: "tags", label: "Tags", icon: Tags },
		{ id: "account", label: "Account", icon: User },
		{ id: "authentication", label: "Auth", icon: Shield },
		{ id: "appearance", label: "Appearance", icon: Palette },
		{ id: "backup", label: "Backup", icon: Archive },
		{ id: "system", label: "System", icon: Cpu },
	];

	// Loading state
	if (servicesLoading && !services.length) {
		return <PremiumPageLoading showHeader cardCount={4} />;
	}

	return (
		<>
			{/* Premium Header */}
			<PremiumPageHeader
				label="Configuration"
				labelIcon={Settings}
				title="Settings"
				gradientTitle
				description="Manage your service instances, authentication, appearance and system preferences"
			/>

			{/* Premium Tab Navigation */}
			<div
				className="animate-in fade-in slide-in-from-bottom-4 duration-500"
				style={{ animationDelay: "100ms", animationFillMode: "backwards" }}
			>
				<PremiumTabs
					tabs={tabConfig}
					activeTab={activeTab}
					onTabChange={(tabId) => setActiveTab(tabId as TabType)}
				/>
			</div>

			{/* Tab Content */}
			<div
				className="animate-in fade-in slide-in-from-bottom-4 duration-500"
				style={{ animationDelay: "200ms", animationFillMode: "backwards" }}
			>
				{/* Services tab */}
				{activeTab === "services" && (
					<div
						role="tabpanel"
						id="settings-panel-services"
						aria-labelledby="settings-tab-services"
						className="grid gap-6 xl:grid-cols-[2fr_1fr]"
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
						<SessionsSection />
					</div>
				)}

				{/* Appearance tab */}
				{activeTab === "appearance" && (
					<div
						role="tabpanel"
						id="settings-panel-appearance"
						aria-labelledby="settings-tab-appearance"
					>
						<AppearanceTab />
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
			</div>
		</>
	);
};
