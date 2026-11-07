"use client";

import { Archive, Bell, Cpu, Palette, Server, Settings, Shield, Tags, User } from "lucide-react";
import { useEffect, useMemo, useState } from "react";
import {
	PremiumPageHeader,
	PremiumPageLoading,
	type PremiumTab,
	PremiumTabs,
} from "../../../components/layout";
import { useCurrentUser } from "../../../hooks/api/useAuth";
import { useServicesQuery } from "../../../hooks/api/useServicesQuery";
import { useTagsQuery } from "../../../hooks/api/useTags";
import { useThemeGradient } from "../../../hooks/useThemeGradient";
import { NotificationsTab } from "../../notifications/components/notifications-tab";
import {
	useAccountManagement,
	useServiceFormState,
	useServicesManagement,
	useTagsManagement,
} from "../hooks";
import { TABS, type TabType } from "../lib/settings-constants";
import { AccountTab } from "./account-tab";
import { AppearanceTab } from "./appearance-tab";
import { BackupTab } from "./backup-tab";
import { GettingStartedBanner } from "./getting-started-banner";
import { OIDCProviderSection } from "./oidc-provider-section";
import { PasskeySection } from "./passkey-section";
import { PasswordSection } from "./password-section";
import { ServiceForm } from "./service-form";
import { ServicesTab } from "./services-tab";
import { SessionsSection } from "./sessions-section";
import { SystemTab } from "./system-tab";
import { TagsTab } from "./tags-tab";

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
	const tagsQuery = useTagsQuery();
	const tags = tagsQuery.data ?? [];
	const { data: currentUser } = useCurrentUser();

	// Local state
	const [activeTab, setActiveTab] = useState<TabType>("services");

	// Keep deep links in sync when Settings stays mounted across hash navigation.
	useEffect(() => {
		const selectHashTab = () => {
			const hash = window.location.hash.slice(1);
			if ((TABS as readonly string[]).includes(hash)) {
				setActiveTab(hash as TabType);
			}
		};
		selectHashTab();
		window.addEventListener("hashchange", selectHashTab);
		return () => window.removeEventListener("hashchange", selectHashTab);
	}, []);

	// Custom hooks
	const serviceFormState = useServiceFormState();
	const servicesManagement = useServicesManagement({
		formState: serviceFormState.formState,
		selectedServiceId: serviceFormState.selectedServiceForEdit?.id,
	});
	const tagsManagement = useTagsManagement();
	const tagsUnavailable = tagsQuery.isError || (!tagsQuery.data && tagsQuery.errorUpdatedAt > 0);
	const accountManagement = useAccountManagement(currentUser);

	// Available tags for autocomplete
	const availableTags = useMemo(() => tags.map((tag) => tag.name), [tags]);

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
		{ id: "notifications", label: "Notifications", icon: Bell },
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
					<div role="tabpanel" id="settings-panel-services" aria-labelledby="settings-tab-services">
						<GettingStartedBanner
							services={services}
							onSelectService={(service) => serviceFormState.resetForm(service)}
						/>
						<div className="grid gap-4 sm:gap-6 xl:grid-cols-[2fr_1fr]">
							<ServicesTab
								services={services}
								isLoading={servicesLoading}
								onTestConnection={servicesManagement.handleTestConnection}
								onEdit={serviceFormState.handleEdit}
								onToggleDefault={servicesManagement.toggleDefault}
								onToggleEnabled={servicesManagement.toggleEnabled}
								onDelete={handleDeleteService}
								onInspectIdentity={(instance) => {
									serviceFormState.handleEdit(instance);
									void servicesManagement.inspectIdentity(instance);
								}}
								testingConnection={servicesManagement.testingConnection}
								testResult={servicesManagement.testResult}
								mutationPending={servicesManagement.updateServiceMutation.isPending}
							/>

							<ServiceForm
								formState={serviceFormState.formState}
								onFormStateChange={serviceFormState.setFormState}
								onSubmit={handleServiceFormSubmit}
								onCancel={() => serviceFormState.resetForm(serviceFormState.formState.service)}
								onTestConnection={(draft) =>
									servicesManagement.handleTestFormConnection(
										draft ?? serviceFormState.formState,
										serviceFormState.selectedServiceForEdit,
									)
								}
								selectedService={serviceFormState.selectedServiceForEdit}
								services={services}
								availableTags={availableTags}
								isCreating={servicesManagement.createServiceMutation.isPending}
								isUpdating={servicesManagement.updateServiceMutation.isPending}
								isTesting={servicesManagement.testingFormConnection}
								testResult={servicesManagement.formTestResult}
								identityFlow={servicesManagement.identityFlow}
								onConfirmIdentity={() => void servicesManagement.confirmIdentity()}
								onDismissIdentityFlow={servicesManagement.dismissIdentityFlow}
								onInspectIdentity={() => {
									if (serviceFormState.selectedServiceForEdit) {
										void servicesManagement.inspectIdentity(
											serviceFormState.selectedServiceForEdit,
										);
									}
								}}
							/>
						</div>
					</div>
				)}

				{/* Tags tab */}
				{activeTab === "tags" && (
					<div role="tabpanel" id="settings-panel-tags" aria-labelledby="settings-tab-tags">
						<TagsTab
							tags={tags}
							newTagName={tagsManagement.newTagName}
							onNewTagNameChange={tagsManagement.setNewTagName}
							onCreateTag={tagsManagement.handleCreateTag}
							onDeleteTag={tagsManagement.handleDeleteTag}
							isCreatingTag={tagsManagement.createTagMutation.isPending}
							isDeletingTag={tagsManagement.deleteTagMutation.isPending}
							readStatus={
								tagsUnavailable ? "unavailable" : tagsQuery.isLoading ? "loading" : "ready"
							}
							hasCachedTags={tagsQuery.data !== undefined}
							isFetchingTags={tagsQuery.isFetching}
							onRetryTags={() => void tagsQuery.refetch()}
							actionError={
								tagsManagement.createTagMutation.isError
									? "Could not create the tag. Your draft has been kept; please try again."
									: tagsManagement.deleteTagMutation.isError
										? "Could not remove the tag. It is still listed; please try again."
										: null
							}
						/>
					</div>
				)}

				{/* Account tab */}
				{activeTab === "account" && (
					<div role="tabpanel" id="settings-panel-account" aria-labelledby="settings-tab-account">
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
						<OIDCProviderSection currentUser={currentUser} />
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
					<div role="tabpanel" id="settings-panel-backup" aria-labelledby="settings-tab-backup">
						<BackupTab />
					</div>
				)}

				{/* Notifications tab */}
				{activeTab === "notifications" && (
					<div
						role="tabpanel"
						id="settings-panel-notifications"
						aria-labelledby="settings-tab-notifications"
					>
						<NotificationsTab />
					</div>
				)}

				{/* System tab */}
				{activeTab === "system" && (
					<div role="tabpanel" id="settings-panel-system" aria-labelledby="settings-tab-system">
						<SystemTab />
					</div>
				)}
			</div>
		</>
	);
};
