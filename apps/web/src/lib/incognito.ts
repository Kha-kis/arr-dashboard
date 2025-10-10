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
	if (!value) return linuxIsoNames[0];

	let hashSum = 0;
	for (let i = 0; i < value.length; i++) {
		hashSum += value.charCodeAt(i);
	}
	return linuxIsoNames[hashSum % linuxIsoNames.length];
}

// Generate deterministic Linux save path based on string
export function getLinuxSavePath(value: string): string {
	if (!value) return LINUX_SAVE_PATHS[0];

	let hashSum = 0;
	for (let i = 0; i < Math.min(8, value.length); i++) {
		hashSum += value.charCodeAt(i) * (i + 3);
	}
	return LINUX_SAVE_PATHS[hashSum % LINUX_SAVE_PATHS.length];
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

// Blur IP addresses
export function getLinuxIpAddress(ip: string): string {
	if (ip === "127.0.0.1" || ip === "localhost" || ip === "::1") return ip;
	return "192.168.1.100";
}

// Generic API URL
export function getLinuxUrl(_url: string): string {
	return "http://192.168.1.100:8080";
}

// Re-export the hook from context
export { useIncognitoMode } from "../contexts/IncognitoContext";
