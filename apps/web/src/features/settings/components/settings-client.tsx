"use client";

import { useMemo, useState } from "react";
import type { CurrentUser } from "@arr/shared";
import { useServicesQuery } from "../../../hooks/api/useServicesQuery";
import { useTagsQuery } from "../../../hooks/api/useTags";
import { useDiscoverOptionsQuery } from "../../../hooks/api/useDiscover";
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
	const { data: currentUser } = useCurrentUser() as { data: CurrentUser | null | undefined };

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

	// Fetch instance options for default settings
	const {
		data: instanceOptions,
		isLoading: optionsLoading,
		isFetching: optionsFetching,
		isError: optionsError,
	} = useDiscoverOptionsQuery(
		editingSupportsDefaults ? (serviceFormState.selectedServiceForEdit?.id ?? null) : null,
		serviceFormState.selectedServiceForEdit?.service === "sonarr" ? "series" : "movie",
		editingSupportsDefaults,
	);

	const optionsPending = optionsLoading || optionsFetching;
	const optionsData = instanceOptions ?? null;
	const optionsLoadFailed = Boolean(
		editingSupportsDefaults && !optionsPending && (optionsError || !optionsData),
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
			<div className="flex items-center gap-4 border-b border-white/10 pb-4">
				{TABS.map((tab) => (
					<button
						key={tab}
						type="button"
						onClick={() => setActiveTab(tab)}
						className={cn(
							"px-3 py-2 text-sm font-medium uppercase tracking-wide transition",
							activeTab === tab
								? "border-b-2 border-sky-400 text-white"
								: "text-white/50 hover:text-white",
						)}
					>
						{tab}
					</button>
				))}
			</div>

			{/* Services tab */}
			{activeTab === "services" && (
				<div className="grid gap-6 xl:grid-cols-[2fr,1fr]">
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
				<TagsTab
					tags={tags}
					newTagName={tagsManagement.newTagName}
					onNewTagNameChange={tagsManagement.setNewTagName}
					onCreateTag={tagsManagement.handleCreateTag}
					onDeleteTag={(id) => tagsManagement.deleteTagMutation.mutate(id)}
					isCreatingTag={tagsManagement.deleteTagMutation.isPending}
					isDeletingTag={tagsManagement.deleteTagMutation.isPending}
				/>
			)}

			{/* Account tab */}
			{activeTab === "account" && (
				<AccountTab
					currentUser={currentUser}
					accountForm={accountManagement.accountForm}
					onAccountFormChange={accountManagement.setAccountForm}
					onAccountUpdate={accountManagement.handleAccountUpdate}
					isUpdating={accountManagement.updateAccountMutation.isPending}
					updateResult={accountManagement.accountUpdateResult}
				/>
			)}

			{/* Authentication tab */}
			{activeTab === "authentication" && (
				<div className="space-y-6">
					<PasswordSection currentUser={currentUser} />
					<PasskeySection />
					<OIDCProviderSection />
				</div>
			)}

			{/* Backup tab */}
			{activeTab === "backup" && <BackupTab />}
		</section>
	);
};
