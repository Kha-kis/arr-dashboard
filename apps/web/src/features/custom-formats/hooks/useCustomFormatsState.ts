/**
 * Custom hook for managing Custom Formats state
 * Consolidates all state management using useReducer for better performance
 */

import { useReducer, useCallback, useMemo } from 'react';
import type { CustomFormat } from '@arr/shared';

// State types
export interface CustomFormatsFilters {
	searchQuery: string;
	instanceFilter: string;
	showOnlyTrash: boolean;
	showOnlyExcluded: boolean;
}

export interface CustomFormatsViewSettings {
	mode: 'cards' | 'table';
	sortColumn: 'name' | 'instance' | 'specifications';
	sortDirection: 'asc' | 'desc';
}

export interface CustomFormatsModals {
	form: {
		isOpen: boolean;
		format: CustomFormat | null;
		instanceId: string | null;
		trashFormat: any | null;
	};
	import: {
		isOpen: boolean;
		instanceId: string | null;
		instanceLabel: string;
	};
	export: {
		isOpen: boolean;
		format: any | null;
		formatName: string;
	};
	trashBrowser: {
		isOpen: boolean;
	};
	untrackDialog: {
		isOpen: boolean;
		target: {
			instanceId: string;
			groupFileName: string;
			groupName: string;
		} | null;
		deleteFormats: boolean;
	};
}

export interface CustomFormatsState {
	filters: CustomFormatsFilters;
	view: CustomFormatsViewSettings;
	selection: Set<string>;
	modals: CustomFormatsModals;
	activeTab: 'formats' | 'scoring' | 'auto-sync' | 'quality-profiles';
	scoringInstanceId: string;
	qualityProfileInstanceId: string;
}

// Action types
export type CustomFormatsAction =
	| { type: 'SET_FILTER'; payload: Partial<CustomFormatsFilters> }
	| { type: 'RESET_FILTERS' }
	| { type: 'SET_VIEW_MODE'; payload: 'cards' | 'table' }
	| { type: 'SET_SORT'; payload: { column: 'name' | 'instance' | 'specifications'; direction?: 'asc' | 'desc' } }
	| { type: 'TOGGLE_SELECTION'; payload: string }
	| { type: 'SELECT_ALL'; payload: string[] }
	| { type: 'CLEAR_SELECTION' }
	| { type: 'SET_ACTIVE_TAB'; payload: 'formats' | 'scoring' | 'auto-sync' | 'quality-profiles' }
	| { type: 'SET_SCORING_INSTANCE'; payload: string }
	| { type: 'SET_QUALITY_PROFILE_INSTANCE'; payload: string }
	| { type: 'OPEN_FORM_MODAL'; payload: { format?: CustomFormat | null; instanceId?: string | null; trashFormat?: any | null } }
	| { type: 'CLOSE_FORM_MODAL' }
	| { type: 'OPEN_IMPORT_MODAL'; payload: { instanceId: string; instanceLabel: string } }
	| { type: 'CLOSE_IMPORT_MODAL' }
	| { type: 'OPEN_EXPORT_MODAL'; payload: { format: any; formatName: string } }
	| { type: 'CLOSE_EXPORT_MODAL' }
	| { type: 'OPEN_TRASH_BROWSER' }
	| { type: 'CLOSE_TRASH_BROWSER' }
	| { type: 'OPEN_UNTRACK_DIALOG'; payload: { instanceId: string; groupFileName: string; groupName: string } }
	| { type: 'CLOSE_UNTRACK_DIALOG' }
	| { type: 'SET_DELETE_FORMATS'; payload: boolean };

// Initial state
const initialState: CustomFormatsState = {
	filters: {
		searchQuery: '',
		instanceFilter: 'all',
		showOnlyTrash: false,
		showOnlyExcluded: false,
	},
	view: {
		mode: 'cards',
		sortColumn: 'name',
		sortDirection: 'asc',
	},
	selection: new Set(),
	modals: {
		form: {
			isOpen: false,
			format: null,
			instanceId: null,
			trashFormat: null,
		},
		import: {
			isOpen: false,
			instanceId: null,
			instanceLabel: '',
		},
		export: {
			isOpen: false,
			format: null,
			formatName: '',
		},
		trashBrowser: {
			isOpen: false,
		},
		untrackDialog: {
			isOpen: false,
			target: null,
			deleteFormats: true,
		},
	},
	activeTab: 'formats',
	scoringInstanceId: '',
	qualityProfileInstanceId: '',
};

// Reducer
function customFormatsReducer(
	state: CustomFormatsState,
	action: CustomFormatsAction
): CustomFormatsState {
	switch (action.type) {
		case 'SET_FILTER':
			return {
				...state,
				filters: {
					...state.filters,
					...action.payload,
				},
			};

		case 'RESET_FILTERS':
			return {
				...state,
				filters: initialState.filters,
			};

		case 'SET_VIEW_MODE':
			return {
				...state,
				view: {
					...state.view,
					mode: action.payload,
				},
			};

		case 'SET_SORT': {
			const { column, direction } = action.payload;
			const newDirection = direction ||
				(state.view.sortColumn === column
					? state.view.sortDirection === 'asc' ? 'desc' : 'asc'
					: 'asc');

			return {
				...state,
				view: {
					...state.view,
					sortColumn: column,
					sortDirection: newDirection,
				},
			};
		}

		case 'TOGGLE_SELECTION': {
			const newSelection = new Set(state.selection);
			if (newSelection.has(action.payload)) {
				newSelection.delete(action.payload);
			} else {
				newSelection.add(action.payload);
			}
			return {
				...state,
				selection: newSelection,
			};
		}

		case 'SELECT_ALL':
			return {
				...state,
				selection: new Set(action.payload),
			};

		case 'CLEAR_SELECTION':
			return {
				...state,
				selection: new Set(),
			};

		case 'SET_ACTIVE_TAB':
			return {
				...state,
				activeTab: action.payload,
			};

		case 'SET_SCORING_INSTANCE':
			return {
				...state,
				scoringInstanceId: action.payload,
			};

		case 'SET_QUALITY_PROFILE_INSTANCE':
			return {
				...state,
				qualityProfileInstanceId: action.payload,
			};

		case 'OPEN_FORM_MODAL':
			return {
				...state,
				modals: {
					...state.modals,
					form: {
						isOpen: true,
						format: action.payload.format || null,
						instanceId: action.payload.instanceId || null,
						trashFormat: action.payload.trashFormat || null,
					},
				},
			};

		case 'CLOSE_FORM_MODAL':
			return {
				...state,
				modals: {
					...state.modals,
					form: {
						isOpen: false,
						format: null,
						instanceId: null,
						trashFormat: null,
					},
				},
			};

		case 'OPEN_IMPORT_MODAL':
			return {
				...state,
				modals: {
					...state.modals,
					import: {
						isOpen: true,
						instanceId: action.payload.instanceId,
						instanceLabel: action.payload.instanceLabel,
					},
				},
			};

		case 'CLOSE_IMPORT_MODAL':
			return {
				...state,
				modals: {
					...state.modals,
					import: {
						isOpen: false,
						instanceId: null,
						instanceLabel: '',
					},
				},
			};

		case 'OPEN_EXPORT_MODAL':
			return {
				...state,
				modals: {
					...state.modals,
					export: {
						isOpen: true,
						format: action.payload.format,
						formatName: action.payload.formatName,
					},
				},
			};

		case 'CLOSE_EXPORT_MODAL':
			return {
				...state,
				modals: {
					...state.modals,
					export: {
						isOpen: false,
						format: null,
						formatName: '',
					},
				},
			};

		case 'OPEN_TRASH_BROWSER':
			return {
				...state,
				modals: {
					...state.modals,
					trashBrowser: {
						isOpen: true,
					},
				},
			};

		case 'CLOSE_TRASH_BROWSER':
			return {
				...state,
				modals: {
					...state.modals,
					trashBrowser: {
						isOpen: false,
					},
				},
			};

		case 'OPEN_UNTRACK_DIALOG':
			return {
				...state,
				modals: {
					...state.modals,
					untrackDialog: {
						isOpen: true,
						target: action.payload,
						deleteFormats: true,
					},
				},
			};

		case 'CLOSE_UNTRACK_DIALOG':
			return {
				...state,
				modals: {
					...state.modals,
					untrackDialog: {
						isOpen: false,
						target: null,
						deleteFormats: true,
					},
				},
			};

		case 'SET_DELETE_FORMATS':
			return {
				...state,
				modals: {
					...state.modals,
					untrackDialog: {
						...state.modals.untrackDialog,
						deleteFormats: action.payload,
					},
				},
			};

		default:
			return state;
	}
}

/**
 * Custom hook for managing Custom Formats state
 */
export function useCustomFormatsState() {
	const [state, dispatch] = useReducer(customFormatsReducer, initialState);

	// Memoized action creators
	const actions = useMemo(() => ({
		setFilter: (filter: Partial<CustomFormatsFilters>) =>
			dispatch({ type: 'SET_FILTER', payload: filter }),

		resetFilters: () =>
			dispatch({ type: 'RESET_FILTERS' }),

		setViewMode: (mode: 'cards' | 'table') =>
			dispatch({ type: 'SET_VIEW_MODE', payload: mode }),

		setSort: (column: 'name' | 'instance' | 'specifications', direction?: 'asc' | 'desc') =>
			dispatch({ type: 'SET_SORT', payload: { column, direction } }),

		toggleSelection: (key: string) =>
			dispatch({ type: 'TOGGLE_SELECTION', payload: key }),

		selectAll: (keys: string[]) =>
			dispatch({ type: 'SELECT_ALL', payload: keys }),

		clearSelection: () =>
			dispatch({ type: 'CLEAR_SELECTION' }),

		setActiveTab: (tab: 'formats' | 'scoring' | 'auto-sync' | 'quality-profiles') =>
			dispatch({ type: 'SET_ACTIVE_TAB', payload: tab }),

		setScoringInstance: (instanceId: string) =>
			dispatch({ type: 'SET_SCORING_INSTANCE', payload: instanceId }),

		setQualityProfileInstance: (instanceId: string) =>
			dispatch({ type: 'SET_QUALITY_PROFILE_INSTANCE', payload: instanceId }),

		openFormModal: (params?: { format?: CustomFormat | null; instanceId?: string | null; trashFormat?: any | null }) =>
			dispatch({ type: 'OPEN_FORM_MODAL', payload: params || {} }),

		closeFormModal: () =>
			dispatch({ type: 'CLOSE_FORM_MODAL' }),

		openImportModal: (instanceId: string, instanceLabel: string) =>
			dispatch({ type: 'OPEN_IMPORT_MODAL', payload: { instanceId, instanceLabel } }),

		closeImportModal: () =>
			dispatch({ type: 'CLOSE_IMPORT_MODAL' }),

		openExportModal: (format: any, formatName: string) =>
			dispatch({ type: 'OPEN_EXPORT_MODAL', payload: { format, formatName } }),

		closeExportModal: () =>
			dispatch({ type: 'CLOSE_EXPORT_MODAL' }),

		openTrashBrowser: () =>
			dispatch({ type: 'OPEN_TRASH_BROWSER' }),

		closeTrashBrowser: () =>
			dispatch({ type: 'CLOSE_TRASH_BROWSER' }),

		openUntrackDialog: (instanceId: string, groupFileName: string, groupName: string) =>
			dispatch({ type: 'OPEN_UNTRACK_DIALOG', payload: { instanceId, groupFileName, groupName } }),

		closeUntrackDialog: () =>
			dispatch({ type: 'CLOSE_UNTRACK_DIALOG' }),

		setDeleteFormats: (deleteFormats: boolean) =>
			dispatch({ type: 'SET_DELETE_FORMATS', payload: deleteFormats }),
	}), []);

	// Helper functions
	const isFormatSelected = useCallback((key: string) => {
		return state.selection.has(key);
	}, [state.selection]);

	const getSelectedCount = useCallback(() => {
		return state.selection.size;
	}, [state.selection]);

	return {
		state,
		actions,
		helpers: {
			isFormatSelected,
			getSelectedCount,
		},
	};
}