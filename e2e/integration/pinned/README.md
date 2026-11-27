# Pinned provider identity lane

Opt-in startup check for native Linux AMD64 Lidarr 3.1.6.5079 and Jellyfin
10.11.11. `images.json` distinguishes the Lidarr OCI index digest, selected AMD64
manifest digest and config digest. Jellyfin is pinned to a single AMD64
manifest. `verify-images.sh` rechecks the registry index, requires exactly one
AMD64 child, fetches and checks its manifest config digest, then confirms the
pulled image architecture and config digest. It checks Lidarr's OCI build
label; the live scenario independently reads `/api/v1/system/status` using
the API key from the fixture's private config file and compares the app
version without printing the key. Jellyfin `/System/Info/Public` reports
`10.11.11`.

Run `node --test e2e/integration/pinned/*.test.mjs` for offline controls.
The manifest checks reject duplicate AMD64 descriptors and digest/config
mismatches. The lifecycle checks verify that unsuccessful Docker enumeration
or inspection leaves the fixture untouched. Run `sh e2e/integration/pinned/run.sh`
for a fresh uniquely
named project, internal-only network, fresh volumes, and a 180-second Compose
health bound. It checks Jellyfin's public version, Lidarr's `/ping` response,
and Lidarr's authenticated runtime version. Cleanup only targets the generated
project. Public image pulls require network access. The run reads the disposable
Lidarr API key inside its container and keeps it out of output. No existing
provider credentials are needed.

This only establishes provider readiness and image identity. It is not
Dashboard compatibility evidence; authenticated setup and populated fixture
behavior are covered separately by `e2e/jellyfin-authority/run-live-matrix.sh`.

Sources: [LinuxServer Lidarr docs](https://docs.linuxserver.io/images/docker-lidarr/),
[Jellyfin container docs](https://jellyfin.org/docs/general/installation/container/),
[Compose networks](https://docs.docker.com/reference/compose-file/networks/).
