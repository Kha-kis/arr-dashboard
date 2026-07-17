import type { LucideIcon } from "lucide-react";
import {
	Activity,
	BarChart3,
	Calendar,
	Compass,
	Eraser,
	Gauge,
	Globe,
	History,
	Inbox,
	LayoutDashboard,
	Library,
	Network,
	Search,
	Settings,
	Sparkles,
	Tag,
	Target,
	Trash2,
} from "lucide-react";

export interface NavigationItem {
	href: string;
	label: string;
	description: string;
	icon: LucideIcon;
	keywords: string[];
}

export interface NavigationGroup {
	id: string;
	label: string;
	items: NavigationItem[];
}

/**
 * The authenticated product map. Both the sidebar and command palette read
 * this inventory so a real destination cannot disappear from one navigation
 * surface while remaining in the other.
 */
export const NAVIGATION_GROUPS: NavigationGroup[] = [
	{
		id: "monitor",
		label: "Monitor",
		items: [
			{
				href: "/dashboard",
				label: "Dashboard",
				description: "Your media system at a glance",
				icon: LayoutDashboard,
				keywords: ["home", "overview"],
			},
			{
				href: "/console",
				label: "Console",
				description: "Attention and safe next actions",
				icon: Gauge,
				keywords: ["operator", "attention", "actions"],
			},
			{
				href: "/pulse",
				label: "Pulse",
				description: "System health and active signals",
				icon: Activity,
				keywords: ["health", "signals", "alerts"],
			},
			{
				href: "/statistics",
				label: "Statistics",
				description: "Explore media and service trends",
				icon: BarChart3,
				keywords: ["analytics", "metrics", "reports"],
			},
		],
	},
	{
		id: "media",
		label: "Media",
		items: [
			{
				href: "/discover",
				label: "Discover",
				description: "Find something worth watching",
				icon: Compass,
				keywords: ["tmdb", "trending", "popular"],
			},
			{
				href: "/requests",
				label: "Requests",
				description: "Review and manage media requests",
				icon: Inbox,
				keywords: ["seerr", "approvals"],
			},
			{
				href: "/calendar",
				label: "Calendar",
				description: "Plan upcoming releases",
				icon: Calendar,
				keywords: ["upcoming", "releases", "schedule"],
			},
			{
				href: "/library",
				label: "Library",
				description: "Browse and manage your collection",
				icon: Library,
				keywords: ["movies", "series", "collection"],
			},
			{
				href: "/search",
				label: "Search",
				description: "Search across your indexers",
				icon: Search,
				keywords: ["find", "prowlarr", "indexers"],
			},
			{
				href: "/history",
				label: "History",
				description: "Review recent media activity",
				icon: History,
				keywords: ["downloads", "activity"],
			},
		],
	},
	{
		id: "automations",
		label: "Automations",
		items: [
			{
				href: "/hunting",
				label: "Hunting",
				description: "Find missing and upgraded media",
				icon: Target,
				keywords: ["missing", "upgrades", "search"],
			},
			{
				href: "/queue-cleaner",
				label: "Queue Cleaner",
				description: "Keep download queues healthy",
				icon: Trash2,
				keywords: ["downloads", "failed", "stalled"],
			},
			{
				href: "/library-cleanup",
				label: "Library Cleanup",
				description: "Review and automate safe cleanup",
				icon: Eraser,
				keywords: ["rules", "removal"],
			},
			{
				href: "/auto-tag",
				label: "Auto-Tagger",
				description: "Apply consistent tags with rules",
				icon: Tag,
				keywords: ["rules", "tags"],
			},
			{
				href: "/label-sync",
				label: "Label Sync",
				description: "Keep labels aligned across services",
				icon: Tag,
				keywords: ["tags", "sync"],
			},
			{
				href: "/cross-seed",
				label: "Cross-Seed",
				description: "Find compatible torrent matches",
				icon: Network,
				keywords: ["torrent", "tracker"],
			},
		],
	},
	{
		id: "integrations",
		label: "Integrations",
		items: [
			{
				href: "/qui",
				label: "qui",
				description: "Torrent-layer overview and attention",
				icon: Network,
				keywords: ["torrent", "qbit", "activity"],
			},
			{
				href: "/qui-activity",
				label: "qui Activity",
				description: "Torrent events, actions, and webhooks",
				icon: History,
				keywords: ["webhook", "events", "audit"],
			},
			{
				href: "/indexers",
				label: "Indexers",
				description: "Search-source health and configuration",
				icon: Globe,
				keywords: ["prowlarr", "torrent", "usenet"],
			},
			{
				href: "/trash-guides",
				label: "TRaSH Guides",
				description: "Apply quality-profile guidance",
				icon: Sparkles,
				keywords: ["quality", "profiles", "custom formats"],
			},
		],
	},
	{
		id: "settings",
		label: "Settings",
		items: [
			{
				href: "/settings",
				label: "Settings",
				description: "Services, security, and preferences",
				icon: Settings,
				keywords: ["services", "security", "preferences"],
			},
		],
	},
];

export const NAVIGATION_ITEMS = NAVIGATION_GROUPS.flatMap((group) => group.items);
