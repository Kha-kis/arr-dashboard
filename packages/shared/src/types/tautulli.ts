export interface TautulliInfo {
	tautulli_version: string;
}

export interface TautulliLibrary {
	section_id: string;
	section_name: string;
	section_type: string;
	count: string;
}

export interface TautulliHistoryItem {
	row_id?: number;
	rating_key: string;
	parent_rating_key: string;
	grandparent_rating_key: string;
	title: string;
	grandparent_title: string;
	media_type: string;
	user: string;
	date: number;
	play_count?: number;
	group_count?: number;
}

export interface TautulliHistorySnapshot {
	items: TautulliHistoryItem[];
	recordsFiltered: number;
	recordsTotal: number;
	complete: boolean;
	incompleteReason?:
		| "page_limit_reached"
		| "upstream_total_changed"
		| "empty_page"
		| "missing_row_id"
		| "duplicate_row_id"
		| "unstable_row_id";
}

export interface TautulliHomeStatRow {
	title: string;
	friendly_name?: string;
	total_plays: number;
	total_duration: number;
	platform?: string;
	thumb?: string;
}

export interface TautulliHomeStat {
	stat_id: string;
	stat_title: string;
	rows: TautulliHomeStatRow[];
}

export interface TautulliUserWatchTimeStat {
	query_days: number;
	total_plays: number;
	total_time: number;
}
