// Incognito mode utilities for disguising sensitive data as Linux ISOs

// Linux ISO names for incognito mode
const linuxIsoNames = [
	"ubuntu-24.04.1-desktop-amd64.iso",
	"ubuntu-24.10-desktop-amd64.iso",
	"ubuntu-22.04.4-server-amd64.iso",
	"debian-12.7.0-amd64-DVD-1.iso",
	"debian-13-trixie-alpha-netinst.iso",
	"Fedora-Workstation-Live-x86_64-41.iso",
	"Fedora-Server-dvd-x86_64-42.iso",
	"archlinux-2024.12.01-x86_64.iso",
	"archlinux-2024.11.01-x86_64.iso",
	"Pop!_OS-24.04-amd64-intel.iso",
	"linuxmint-22-cinnamon-64bit.iso",
	"openSUSE-Tumbleweed-DVD-x86_64-Current.iso",
	"openSUSE-Leap-15.6-DVD-x86_64.iso",
	"manjaro-kde-24.0-240513-linux66.iso",
	"EndeavourOS-Galileo-11-2024.iso",
	"elementary-os-7.1-stable.20231129rc.iso",
	"zorin-os-17.1-core-64bit.iso",
	"MX-23.3_x64.iso",
	"kali-linux-2024.3-installer-amd64.iso",
	"parrot-security-6.0_amd64.iso",
	"rocky-9.4-x86_64-dvd.iso",
	"almalinux-9.4-x86_64-dvd.iso",
	"centos-stream-9-latest-x86_64-dvd1.iso",
	"garuda-dr460nized-linux-zen-240131.iso",
	"artix-base-openrc-20241201-x86_64.iso",
	"void-live-x86_64-20240314-xfce.iso",
	"solus-4.5-budgie.iso",
	"alpine-standard-3.19.1-x86_64.iso",
	"slackware64-15.0-install-dvd.iso",
	"gentoo-install-amd64-minimal-20241201.iso",
	"nixos-24.05-plasma6-x86_64.iso",
	"endeavouros-2024.09.22-x86_64.iso",
	"kubuntu-24.04.1-desktop-amd64.iso",
	"xubuntu-24.04-desktop-amd64.iso",
	"lubuntu-24.04-desktop-amd64.iso",
	"ubuntu-mate-24.04-desktop-amd64.iso",
	"ubuntu-budgie-24.04-desktop-amd64.iso",
	"deepin-desktop-community-23.0-amd64.iso",
	"kde-neon-user-20241205-1344.iso",
	"peppermint-2024-02-02-amd64.iso",
	"tails-amd64-6.8.1.iso",
	"qubes-r4.2.3-x86_64.iso",
	"proxmox-ve_8.2-2.iso",
	"truenas-scale-24.04.2.iso",
	"opnsense-24.7-dvd-amd64.iso",
	"pfsense-ce-2.7.2-amd64.iso",
];

// Linux save paths for incognito mode
const LINUX_SAVE_PATHS = [
	"/home/downloads/distributions",
	"/home/downloads/docs",
	"/home/downloads/source",
	"/home/downloads/live",
	"/home/downloads/server",
	"/home/downloads/desktop",
	"/home/downloads/arm",
	"/mnt/storage/linux-isos",
	"/media/nas/linux",
];

// Generate a deterministic but seemingly random Linux ISO name based on string
export function getLinuxIsoName(value: string): string {
	if (!value) return linuxIsoNames[0]!;

	let hashSum = 0;
	for (let i = 0; i < value.length; i++) {
		hashSum += value.charCodeAt(i);
	}
	return linuxIsoNames[hashSum % linuxIsoNames.length]!;
}

// Generate deterministic Linux save path based on string
export function getLinuxSavePath(value: string): string {
	if (!value) return LINUX_SAVE_PATHS[0]!;

	let hashSum = 0;
	for (let i = 0; i < Math.min(8, value.length); i++) {
		hashSum += value.charCodeAt(i) * (i + 3);
	}
	return LINUX_SAVE_PATHS[hashSum % LINUX_SAVE_PATHS.length]!;
}

// Generic indexer name
export function getLinuxIndexer(_value: string): string {
	return "LinuxTracker";
}

// Generic download client name
export function getLinuxDownloadClient(_value: string): string {
	return "Transmission";
}

// Generic instance names
export function getLinuxInstanceName(value: string): string {
	const lowerValue = value.toLowerCase();
	if (lowerValue.includes("sonarr")) return "Sonarr Main";
	if (lowerValue.includes("radarr")) return "Radarr 4K";
	if (lowerValue.includes("prowlarr")) return "Prowlarr";
	return "Instance";
}

// Generic API URL
export function getLinuxUrl(_url: string): string {
	return "http://localhost";
}

// Generic username based on hash
const LINUX_USERNAMES = [
	"tux",
	"penguin",
	"root",
	"admin",
	"sysadmin",
	"devops",
	"operator",
	"maintainer",
];

export function getLinuxUsername(value: string): string {
	if (!value) return LINUX_USERNAMES[0]!;
	let hashSum = 0;
	for (let i = 0; i < value.length; i++) {
		hashSum += value.charCodeAt(i);
	}
	return LINUX_USERNAMES[hashSum % LINUX_USERNAMES.length]!;
}

// Generic device/player name
const LINUX_DEVICES = [
	"ThinkPad X1",
	"Raspberry Pi",
	"Dell Server",
	"NUC Gateway",
	"Workstation",
	"Home Terminal",
];

export function getLinuxDevice(value: string): string {
	if (!value) return LINUX_DEVICES[0]!;
	let hashSum = 0;
	for (let i = 0; i < value.length; i++) {
		hashSum += value.charCodeAt(i);
	}
	return LINUX_DEVICES[hashSum % LINUX_DEVICES.length]!;
}

// Generic Plex library section names
const LINUX_SECTIONS = [
	"Distributions",
	"Server ISOs",
	"Desktop ISOs",
	"Live Images",
	"ARM Builds",
	"Source Archives",
];

export function getLinuxSectionName(value: string): string {
	if (!value) return LINUX_SECTIONS[0]!;
	let hashSum = 0;
	for (let i = 0; i < value.length; i++) {
		hashSum += value.charCodeAt(i);
	}
	return LINUX_SECTIONS[hashSum % LINUX_SECTIONS.length]!;
}

// Generic server friendly name
export function getLinuxServerName(value: string): string {
	if (!value) return "linux-server";
	let hashSum = 0;
	for (let i = 0; i < value.length; i++) {
		hashSum += value.charCodeAt(i);
	}
	const names = ["linux-server", "media-server", "home-server", "nas-server", "plex-host"];
	return names[hashSum % names.length]!;
}

// Anonymize email addresses
export function getLinuxEmail(email: string): string {
	if (!email) return "user@linux.local";
	const username = getLinuxUsername(email);
	return `${username}@linux.local`;
}

// Anonymize health messages by replacing indexer names and show/movie names
export function anonymizeHealthMessage(message: string): string {
	// Replace patterns like "IndexerName (Prowlarr), OtherIndexer (Prowlarr)" with "LinuxTracker, LinuxTracker"
	let anonymized = message.replace(/[A-Za-z0-9._-]+\s*\(Prowlarr\)/gi, "LinuxTracker");

	// Replace standalone indexer names (without Prowlarr suffix) in lists
	// Pattern: "Indexers unavailable...hours: IndexerA, IndexerB"
	anonymized = anonymized.replace(
		/(Indexers[^:]+:\s*)([A-Za-z0-9._\-, ]+)(\s|$)/gi,
		(match, prefix, indexerList, suffix) => {
			// Split by comma, replace each with LinuxTracker
			const anonymizedList = indexerList
				.split(",")
				.map(() => "LinuxTracker")
				.join(", ");
			return `${prefix}${anonymizedList}${suffix}`;
		},
	);

	// Replace individual series/movie entries: "SeriesName (tvdbid 123456)" or "SeriesName (tmdbid 123456)"
	// This will handle comma-separated lists by processing each item individually
	anonymized = anonymized.replace(
		/([A-Za-z0-9\s.:'&!?()-]+?)\s+\((tvdbid|tmdbid)\s+\d+\)/gi,
		(match, name, idType) => {
			const isoName = getLinuxIsoName(name.trim());
			return `${isoName} (${idType} [redacted])`;
		},
	);

	// Replace download client names in health messages
	// Pattern: "Download client ClientName is set to..." or "Download client ClientName places..."
	anonymized = anonymized.replace(
		/Download client\s+(\S+)/gi,
		"Download client Transmission",
	);

	// Replace any remaining quoted names with generic alternatives
	anonymized = anonymized.replace(/"([^"]+)"/g, '"linux-distribution"');

	return anonymized;
}

/**
 * Anonymize a Pulse item title.
 *
 * Pulse titles follow one of two shapes:
 *   - "InstanceLabel: health message"  (e.g. "Sonarr Prod: Indexer X failed")
 *   - "InstanceLabel is unreachable"   (status strings)
 *
 * We split off the label, replace it with a Linux-themed placeholder via
 * `getLinuxInstanceName`, and run the message half through
 * `anonymizeHealthMessage`. Titles with neither shape fall through to
 * `anonymizeHealthMessage` alone.
 */
export function anonymizePulseText(text: string): string {
	const colonIdx = text.indexOf(": ");
	if (colonIdx > 0) {
		const label = text.slice(0, colonIdx);
		const message = text.slice(colonIdx + 2);
		return `${getLinuxInstanceName(label)}: ${anonymizeHealthMessage(message)}`;
	}
	const isIdx = text.indexOf(" is ");
	if (isIdx > 0) {
		const label = text.slice(0, isIdx);
		const rest = text.slice(isIdx);
		return `${getLinuxInstanceName(label)}${rest}`;
	}
	return anonymizeHealthMessage(text);
}

// Anonymize queue status/error messages
export function anonymizeStatusMessage(message: string): string {
	let anonymized = message;

	// Replace episode patterns like "Episode 1x02" with generic version
	// Keep the episode number pattern but anonymize the context
	anonymized = anonymized.replace(
		/Episode\s+(\d+x\d+)\s+was not found in the grabbed release:\s*(.+)$/gi,
		(_, episode) =>
			`Episode ${episode} was not found in the grabbed release: linux-distribution-v1.0-x86_64`,
	);

	// Replace "grabbed release: Title S01 1080p..." patterns
	anonymized = anonymized.replace(
		/grabbed release:\s*[^\n]+/gi,
		"grabbed release: linux-distribution-v1.0-x86_64",
	);

	// Replace release names with resolution and codec info (most comprehensive pattern)
	// Matches: "Title S01E02 1080p WEB-DL...", "Title 1986 S01E01 Episode Name 1080p..."
	// This catches scene release naming conventions
	anonymized = anonymized.replace(
		/[A-Za-z0-9\s.'\-:]+(?:\d{4}\s+)?S\d{1,2}E\d{1,2}[A-Za-z0-9\s.'\-:]*\d{3,4}p[^\n]*/gi,
		"linux-distribution-v1.0-x86_64",
	);

	// Replace release names that look like media (contain resolution, codec info)
	// Pattern matches things like "Show Name S01E02 1080p WEB-DL..."
	anonymized = anonymized.replace(
		/[A-Za-z0-9\s.'\-:]+\s+S\d{1,2}(?:E\d{1,2})?\s+\d{3,4}p[^\n,]*/gi,
		"linux-distribution-v1.0-x86_64",
	);

	// Replace movie release patterns "Movie Name (2024) 1080p..."
	anonymized = anonymized.replace(
		/[A-Za-z0-9\s.'\-:]+\s+\(\d{4}\)\s+\d{3,4}p[^\n,]*/gi,
		"linux-distribution-v1.0-x86_64",
	);

	// Replace standalone release names with resolution (720p, 1080p, 2160p, etc.)
	// and common release group suffixes
	anonymized = anonymized.replace(
		/[A-Za-z0-9\s.'\-:]{10,}\d{3,4}p[A-Za-z0-9\s.-]*(?:WEB|HDTV|BluRay|BDRip|DVDRip|REMUX|NF|AMZN|DSNP|HMAX)[^\n]*/gi,
		"linux-distribution-v1.0-x86_64",
	);

	// Replace "expected in this release" messages
	anonymized = anonymized.replace(
		/expected in this release were not imported/gi,
		"expected in this distribution were not verified",
	);

	// Replace show/movie titles after common prefixes
	anonymized = anonymized.replace(
		/(for|from|in|of)\s+['"]?[A-Z][A-Za-z0-9\s.'\-:]+['"]?\s*(S\d|Season|\()/gi,
		(_, prefix) => `${prefix} linux-distribution (`,
	);

	// Lidarr: "Couldn't find similar album for [/path/to/Artist - Album (Year) [FLAC]]"
	// Handle nested brackets by matching [/path...] including any nested [...] groups
	anonymized = anonymized.replace(
		/\[\/(?:[^\[\]]|\[[^\]]*\])*\](?:\])?/g,
		`[${LINUX_SAVE_PATHS[0]}/linux-distribution-v1.0-x86_64]`,
	);

	// Lidarr: Music release names "Artist - Album (Year) {Catalog} [FLAC-CD]"
	// Requires a music-release marker: (YYYY) suffix or [FLAC/MP3/etc] bracket
	anonymized = anonymized.replace(
		/[A-Za-z0-9\s.,'&!?]+\s+-\s+[A-Za-z0-9\s.,'&!?]+(?:\s*\(\d{4}\))[^"\n]*/g,
		"linux-distribution-v1.0-x86_64",
	);
	anonymized = anonymized.replace(
		/[A-Za-z0-9\s.,'&!?]+\s+-\s+[A-Za-z0-9\s.,'&!?]+\s*\[(?:FLAC|MP3|AAC|ALAC|OGG|WAV|WEB)[^\]]*\][^"\n]*/gi,
		"linux-distribution-v1.0-x86_64",
	);

	// Replace any remaining quoted strings with generic name
	anonymized = anonymized.replace(/"([^"]+)"/g, '"linux-distribution-v1.0-x86_64"');

	// Keep generic messages as-is
	// "Episode has a TBA title and recently aired" - this is generic enough
	// "One or more episodes expected..." - contains no identifying info

	return anonymized;
}

// Re-export the hook from context
export { useIncognitoMode } from "../contexts/IncognitoContext";
