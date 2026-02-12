export interface TMDBGenre {
	id: number;
	name: string;
}

export interface TMDBGenresResponse {
	genres: TMDBGenre[];
}

export interface TMDBSearchResult {
	id: number;
	tmdbId: number;
	imdbId?: string;
	tvdbId?: number;
	title: string;
	overview: string;
	posterUrl?: string;
	backdropUrl?: string;
	releaseDate?: string;
	rating: number;
	voteCount: number;
	popularity: number;
	genreIds: number[];
}

export interface TMDBPaginatedResponse {
	results: TMDBSearchResult[];
	page: number;
	totalPages: number;
	totalResults: number;
}

export interface TMDBCastMember {
	id: number;
	name: string;
	character?: string;
	characters?: string[];
	episodeCount?: number;
	profileUrl?: string;
	order: number;
}

export interface TMDBCrewMember {
	id: number;
	name: string;
	job?: string;
	jobs?: string[];
	department: string;
	episodeCount?: number;
	profileUrl?: string;
}

export interface TMDBCreditsResponse {
	id: number;
	cast: TMDBCastMember[];
	crew: TMDBCrewMember[];
}

export interface TMDBVideo {
	id: string;
	key: string;
	name: string;
	type: string;
	site: string;
	size: number;
	url: string;
	thumbnailUrl: string;
}

export interface TMDBVideosResponse {
	id: number;
	results: TMDBVideo[];
}

export interface TMDBWatchProvider {
	id: number;
	name: string;
	logoUrl?: string;
}

export interface TMDBWatchProvidersResponse {
	id: number;
	region: string;
	link: string | null;
	flatrate: TMDBWatchProvider[];
	rent: TMDBWatchProvider[];
	buy: TMDBWatchProvider[];
}

export interface TMDBExternalIdsResponse {
	tmdbId: number;
	imdbId: string | null;
	tvdbId: number | null;
}
