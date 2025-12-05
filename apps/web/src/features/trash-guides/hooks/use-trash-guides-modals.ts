import { useState, useCallback } from "react";
import type { TrashTemplate } from "@arr/shared";

type ServiceType = "RADARR" | "SONARR";

/**
 * Hook for managing TRaSH Guides modal states and interactions.
 * Centralizes all modal open/close logic and selected item tracking.
 *
 * @returns Modal state and handlers
 *
 * @example
 * const {
 *   editorOpen,
 *   importOpen,
 *   qualityProfileBrowserOpen,
 *   editingTemplate,
 *   selectedServiceType,
 *   handleCreateNew,
 *   handleEdit,
 *   handleCloseEditor,
 *   handleImport,
 *   handleBrowseQualityProfiles,
 *   handleEditTemplate
 * } = useTrashGuidesModals();
 */
export function useTrashGuidesModals() {
	const [editorOpen, setEditorOpen] = useState(false);
	const [importOpen, setImportOpen] = useState(false);
	const [qualityProfileBrowserOpen, setQualityProfileBrowserOpen] = useState(false);
	const [selectedServiceType, setSelectedServiceType] = useState<ServiceType | null>(null);
	const [editingTemplate, setEditingTemplate] = useState<TrashTemplate | undefined>(undefined);

	/**
	 * Open editor for creating a new template
	 */
	const handleCreateNew = useCallback(() => {
		setEditingTemplate(undefined);
		setEditorOpen(true);
	}, []);

	/**
	 * Open editor for editing an existing template
	 */
	const handleEdit = useCallback((template: TrashTemplate) => {
		setEditingTemplate(template);
		setEditorOpen(true);
	}, []);

	/**
	 * Close template editor
	 */
	const handleCloseEditor = useCallback(() => {
		setEditorOpen(false);
		setEditingTemplate(undefined);
	}, []);

	/**
	 * Open import dialog
	 */
	const handleImport = useCallback(() => {
		setImportOpen(true);
	}, []);

	/**
	 * Close import dialog
	 */
	const handleCloseImport = useCallback(() => {
		setImportOpen(false);
	}, []);

	/**
	 * Open quality profile browser for a service type
	 */
	const handleBrowseQualityProfiles = useCallback((serviceType: ServiceType) => {
		setSelectedServiceType(serviceType);
		setEditingTemplate(undefined); // Clear any editing template when browsing
		setQualityProfileBrowserOpen(true);
	}, []);

	/**
	 * Open quality profile wizard with a template to edit
	 */
	const handleEditTemplate = useCallback((template: TrashTemplate) => {
		setEditingTemplate(template);
		setSelectedServiceType(template.serviceType);
		setQualityProfileBrowserOpen(true);
	}, []);

	/**
	 * Close quality profile browser
	 */
	const handleCloseQualityProfileBrowser = useCallback(() => {
		setQualityProfileBrowserOpen(false);
		setSelectedServiceType(null);
		setEditingTemplate(undefined);
	}, []);

	return {
		// Modal states
		editorOpen,
		importOpen,
		qualityProfileBrowserOpen,
		selectedServiceType,
		editingTemplate,

		// Editor handlers
		handleCreateNew,
		handleEdit,
		handleCloseEditor,

		// Import handlers
		handleImport,
		handleCloseImport,

		// Quality profile browser handlers
		handleBrowseQualityProfiles,
		handleEditTemplate,
		handleCloseQualityProfileBrowser,
	};
}
