/**
 * Service → strategy lookup for the label-sync executor.
 *
 * Adding a new service is two edits: register a SourceReader here on the
 * `SOURCE_READERS` map and a DestWriter on the `DEST_WRITERS` map. The
 * executor itself stays untouched.
 */

import type { LabelSyncService } from "@arr/shared";
import { radarrDestWriter, sonarrDestWriter } from "./dest-writers/arr-writer.js";
import { embyDestWriter, jellyfinDestWriter } from "./dest-writers/jellyfin-writer.js";
import { plexDestWriter } from "./dest-writers/plex-writer.js";
import { radarrSourceReader, sonarrSourceReader } from "./source-readers/arr-reader.js";
import { embySourceReader, jellyfinSourceReader } from "./source-readers/jellyfin-reader.js";
import { plexSourceReader } from "./source-readers/plex-reader.js";
import type { DestWriter, SourceReader } from "./strategy-types.js";

export const SOURCE_READERS: Record<LabelSyncService, SourceReader> = {
	sonarr: sonarrSourceReader,
	radarr: radarrSourceReader,
	plex: plexSourceReader,
	jellyfin: jellyfinSourceReader,
	emby: embySourceReader,
};

export const DEST_WRITERS: Record<LabelSyncService, DestWriter> = {
	sonarr: sonarrDestWriter,
	radarr: radarrDestWriter,
	plex: plexDestWriter,
	jellyfin: jellyfinDestWriter,
	emby: embyDestWriter,
};
