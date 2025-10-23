/**
 * Custom Format Usage Descriptions
 *
 * Hardcoded descriptions for custom formats that don't have trash_description
 * in the TRaSH JSON files but have important usage information in the guides.
 */

export const CF_DESCRIPTIONS: Record<string, { html: string; source?: string }> = {
	// Anime - Radarr
	"Anime Dual Audio": {
		html: `
			<h4>Dual Audio Scoring</h4>
			<p>If you prefer Dual Audio releases you have a few options depending on your preference:</p>
			<ul>
				<li>If you want to prefer Dual Audio within the same tier give the CF a score of <strong>10</strong></li>
				<li>If you want it to be preferred a tier above give the CF a score of <strong>101</strong></li>
				<li>If you want to prefer it over any tiers give the CF a score of <strong>2000</strong></li>
			</ul>
			<p>If you <strong>must have</strong> Dual Audio releases, set the Minimum Custom Format Score to <strong>2000</strong> in your quality profile.</p>
			<p>Using this scoring you will still benefit from the tiers if a better release group does a Dual Audio release.</p>
		`,
		source: "https://trash-guides.info/Radarr/radarr-setup-quality-profiles-anime/#dual-audio-scoring"
	},

	"Uncensored": {
		html: `
			<h4>Uncensored</h4>
			<p>This custom format matches releases that are marked as uncensored. Anime releases can be censored (usually for TV broadcast) or uncensored (usually for BD/Blu-ray releases).</p>
			<p><strong>Recommended Scoring:</strong></p>
			<ul>
				<li>If you prefer uncensored releases: <strong>10-100</strong> (prefer within tier)</li>
				<li>If you require uncensored: Set Minimum Custom Format Score to match this CF's score</li>
			</ul>
			<p>Note: Not all anime have both censored and uncensored versions. This CF will only match when the release explicitly indicates it's uncensored.</p>
		`,
		source: "https://trash-guides.info/Radarr/Radarr-collection-of-custom-formats/"
	},

	// Anime - Sonarr
	"Anime Dual Audio": {
		html: `
			<h4>Dual Audio Scoring</h4>
			<p>If you prefer Dual Audio releases you have a few options depending on your preference:</p>
			<ul>
				<li>If you want to prefer Dual Audio within the same tier give the CF a score of <strong>10</strong></li>
				<li>If you want it to be preferred a tier above give the CF a score of <strong>101</strong></li>
				<li>If you want to prefer it over any tiers give the CF a score of <strong>2000</strong></li>
			</ul>
			<p>If you <strong>must have</strong> Dual Audio releases, set the Minimum Custom Format Score to <strong>2000</strong> in your quality profile.</p>
			<p>Using this scoring you will still benefit from the tiers if a better release group does a Dual Audio release.</p>
		`,
		source: "https://trash-guides.info/Sonarr/sonarr-setup-quality-profiles-anime/#dual-audio-scoring"
	},

	// Add more as needed...
};

/**
 * Get description for a custom format by name
 */
export function getCFDescription(cfName: string): { html: string; source?: string } | undefined {
	return CF_DESCRIPTIONS[cfName];
}
