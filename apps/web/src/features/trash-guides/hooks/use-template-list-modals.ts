import { useReducer } from "react";
import type { TrashTemplate } from "@arr/shared";

// ── State shape (matches the original useState types exactly) ──

export interface TemplateListModalState {
	deleteConfirm: string | null;
	duplicateName: string;
	duplicatingId: string | null;
	instanceSelectorTemplate: {
		templateId: string;
		templateName: string;
		serviceType: "RADARR" | "SONARR";
	} | null;
	validationModal: {
		templateId: string;
		templateName: string;
		instanceId: string;
		instanceName: string;
	} | null;
	progressModal: {
		syncId: string;
		templateName: string;
		instanceName: string;
	} | null;
	deploymentModal: {
		templateId: string;
		templateName: string;
		instanceId: string;
		instanceLabel: string;
	} | null;
	exportModal: {
		templateId: string;
		templateName: string;
	} | null;
	importModal: boolean;
	unlinkConfirm: {
		templateId: string;
		templateName: string;
		instanceId: string;
		instanceName: string;
	} | null;
	bulkDeployModal: {
		templateId: string;
		templateName: string;
		serviceType: "RADARR" | "SONARR";
		templateDefaultQualityConfig?: TrashTemplate["config"]["customQualityConfig"];
		instanceOverrides?: TrashTemplate["instanceOverrides"];
		instances: Array<{ instanceId: string; instanceLabel: string; instanceType: string }>;
	} | null;
}

// ── Actions ──

type ModalAction =
	// Simple open/close
	| { type: "OPEN_DELETE"; templateId: string }
	| { type: "CLOSE_DELETE" }
	| { type: "OPEN_DUPLICATE"; templateId: string; defaultName: string }
	| { type: "SET_DUPLICATE_NAME"; name: string }
	| { type: "CLOSE_DUPLICATE" }
	| { type: "OPEN_INSTANCE_SELECTOR"; data: TemplateListModalState["instanceSelectorTemplate"] }
	| { type: "CLOSE_INSTANCE_SELECTOR" }
	| { type: "OPEN_VALIDATION"; data: NonNullable<TemplateListModalState["validationModal"]> }
	| { type: "CLOSE_VALIDATION" }
	| { type: "OPEN_PROGRESS"; data: NonNullable<TemplateListModalState["progressModal"]> }
	| { type: "CLOSE_PROGRESS" }
	| { type: "OPEN_DEPLOYMENT"; data: NonNullable<TemplateListModalState["deploymentModal"]> }
	| { type: "CLOSE_DEPLOYMENT" }
	| { type: "OPEN_EXPORT"; data: NonNullable<TemplateListModalState["exportModal"]> }
	| { type: "CLOSE_EXPORT" }
	| { type: "OPEN_IMPORT" }
	| { type: "CLOSE_IMPORT" }
	| { type: "OPEN_UNLINK"; data: NonNullable<TemplateListModalState["unlinkConfirm"]> }
	| { type: "CLOSE_UNLINK" }
	| { type: "OPEN_BULK_DEPLOY"; data: NonNullable<TemplateListModalState["bulkDeployModal"]> }
	| { type: "CLOSE_BULK_DEPLOY" }
	// Compound transitions
	| { type: "INSTANCE_TO_DEPLOY"; data: NonNullable<TemplateListModalState["deploymentModal"]> }
	| { type: "INSTANCE_TO_BULK"; data: NonNullable<TemplateListModalState["bulkDeployModal"]> }
	| { type: "VALIDATION_TO_PROGRESS"; data: NonNullable<TemplateListModalState["progressModal"]> };

// ── Initial state ──

const initialState: TemplateListModalState = {
	deleteConfirm: null,
	duplicateName: "",
	duplicatingId: null,
	instanceSelectorTemplate: null,
	validationModal: null,
	progressModal: null,
	deploymentModal: null,
	exportModal: null,
	importModal: false,
	unlinkConfirm: null,
	bulkDeployModal: null,
};

// ── Reducer ──

function modalReducer(state: TemplateListModalState, action: ModalAction): TemplateListModalState {
	switch (action.type) {
		case "OPEN_DELETE":
			return { ...state, deleteConfirm: action.templateId };
		case "CLOSE_DELETE":
			return { ...state, deleteConfirm: null };
		case "OPEN_DUPLICATE":
			return { ...state, duplicatingId: action.templateId, duplicateName: action.defaultName };
		case "SET_DUPLICATE_NAME":
			return { ...state, duplicateName: action.name };
		case "CLOSE_DUPLICATE":
			return { ...state, duplicatingId: null, duplicateName: "" };
		case "OPEN_INSTANCE_SELECTOR":
			return { ...state, instanceSelectorTemplate: action.data };
		case "CLOSE_INSTANCE_SELECTOR":
			return { ...state, instanceSelectorTemplate: null };
		case "OPEN_VALIDATION":
			return { ...state, validationModal: action.data };
		case "CLOSE_VALIDATION":
			return { ...state, validationModal: null };
		case "OPEN_PROGRESS":
			return { ...state, progressModal: action.data };
		case "CLOSE_PROGRESS":
			return { ...state, progressModal: null };
		case "OPEN_DEPLOYMENT":
			return { ...state, deploymentModal: action.data };
		case "CLOSE_DEPLOYMENT":
			return { ...state, deploymentModal: null };
		case "OPEN_EXPORT":
			return { ...state, exportModal: action.data };
		case "CLOSE_EXPORT":
			return { ...state, exportModal: null };
		case "OPEN_IMPORT":
			return { ...state, importModal: true };
		case "CLOSE_IMPORT":
			return { ...state, importModal: false };
		case "OPEN_UNLINK":
			return { ...state, unlinkConfirm: action.data };
		case "CLOSE_UNLINK":
			return { ...state, unlinkConfirm: null };
		case "OPEN_BULK_DEPLOY":
			return { ...state, bulkDeployModal: action.data };
		case "CLOSE_BULK_DEPLOY":
			return { ...state, bulkDeployModal: null };
		// Compound transitions — atomically close one modal and open another
		case "INSTANCE_TO_DEPLOY":
			return { ...state, instanceSelectorTemplate: null, deploymentModal: action.data };
		case "INSTANCE_TO_BULK":
			return { ...state, instanceSelectorTemplate: null, bulkDeployModal: action.data };
		case "VALIDATION_TO_PROGRESS":
			return { ...state, validationModal: null, progressModal: action.data };
		default: {
			const _exhaustive: never = action;
			return state;
		}
	}
}

// ── Hook ──

export function useTemplateListModals() {
	return useReducer(modalReducer, initialState);
}
