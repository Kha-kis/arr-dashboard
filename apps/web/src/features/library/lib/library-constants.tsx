import type { ReactNode } from "react";
import { BookOpen, Film, Library as LibraryIcon, Music, Tv } from "lucide-react";
import type { LibraryService } from "@arr/shared";

export const SERVICE_OPTIONS: Array<{
	value: "all" | LibraryService;
	label: string;
	icon: ReactNode;
}> = [
	{ value: "all", label: "All", icon: <LibraryIcon className="h-4 w-4" /> },
	{ value: "radarr", label: "Movies", icon: <Film className="h-4 w-4" /> },
	{ value: "sonarr", label: "Series", icon: <Tv className="h-4 w-4" /> },
	{ value: "lidarr", label: "Artists", icon: <Music className="h-4 w-4" /> },
	{ value: "readarr", label: "Authors", icon: <BookOpen className="h-4 w-4" /> },
];

export const STATUS_FILTERS = [
	{ value: "all", label: "All statuses" },
	{ value: "monitored", label: "Monitored" },
	{ value: "unmonitored", label: "Not monitored" },
] as const;

export const FILE_FILTERS = [
	{ value: "all", label: "All files" },
	{ value: "has-file", label: "Has file" },
	{ value: "missing", label: "Missing file" },
] as const;

export type StatusFilter = (typeof STATUS_FILTERS)[number]["value"];
export type FileFilter = (typeof FILE_FILTERS)[number]["value"];
