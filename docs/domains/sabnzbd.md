# SABnzbd integration

Arr Dashboard can register multiple SABnzbd instances using each instance's base URL and saved API key. Connection checks use that same authenticated API request used by queue reads; they do not rely on the unauthenticated version endpoint. Redirects are refused because SABnzbd sends its API key in the query string.

The Downloads page shows a bounded active queue and recent history. A separate History page supports paged review. Queue status is refreshed while the page is open. Incomplete or unavailable provider observations are shown as such rather than treated as an empty queue.

Operators can pause or resume the whole queue or one exact job, adjust a job's category or priority, and remove a selected queue item. Queue removal is explicit and preserves already-downloaded files. Failed history jobs may be retried one at a time; the result is confirmed only when SABnzbd returns a new job identity and that exact replacement appears in the queue. A history row can be removed only after confirmation, without deleting files. Unconfirmed provider outcomes are not automatically replayed.

The on-demand library match is read-only. It requires an exact configured SABnzbd endpoint and unique download-client name, the same opaque job identity, and a typed Sonarr/Radarr media identity. Ambiguous or incomplete evidence stays unmatched. The integration does not automatically add, remove, retry, or categorize jobs based on Sonarr or Radarr rules. It does not expose raw provider failure details, filesystem paths, URLs, or stage logs in dashboard responses. The upstream API reference describes authentication, queue/history paging, and the provider's action semantics: <https://sabnzbd.org/wiki/configuration/5.1/api.
