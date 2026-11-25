# SQLite storage in Docker

SQLite in the combined Docker image requires an explicitly configured persistent directory for its database. Keep the default `/config` on a Docker-managed named volume or a local directory bind mount. Preserve that same source across upgrades and replacements. If you set a custom SQLite path, mount its whole parent directory so the database, journals and coordination files stay together. Persist `/config` for settings, installation secrets and backups even when the database has a separate path.

For Compose, declare a named volume explicitly:

```yaml
services:
  arr-dashboard:
    image: khak1s/arr-dashboard:<version>
    volumes:
      - arr-dashboard-config:/config
volumes:
  arr-dashboard-config:
```

Alternatively, set a local bind directory as the source for `/config`, as shown in the [Docker setup](../README.md#quick-start). Keep the directory and its effective ownership compatible with the application's runtime UID and GID. For rootless containers use the effective process identity. Otherwise set `PUID` and `PGID` as documented.

The startup check uses the database's resolved location and Linux mount information. The database needs a directory mount on eligible writable local storage such as ext4, XFS, Btrfs or local ZFS. The container check cannot determine whether a Docker volume is named or whether it will be retained. The operator must configure and retain the mount. A file-only mount, tmpfs or the container root filesystem is unsuitable. A NAS-local dataset must also provide effective ownership, native locks and stable identity. Passing the check alone does not establish NAS compatibility. Native SQLite and Docker PostgreSQL keep their existing storage policies.

## Before updating an existing Docker installation

1. Confirm the old container's configured database provider and container-side path, and use `docker inspect --format '{{json .Mounts}}' <container>` locally to check where that path resolves. The default SQLite path is `/config/prod.db`. A custom path or symlink may resolve elsewhere. Keep the old deployment definition and container/image identity private. If there is a suitable existing mount, preserve and reuse it unchanged. A new identity error still requires review.
2. If the database is in the writable layer, preserve the original container, configuration, secrets and any existing backups before pulling and recreating the service. This includes stopping automated replacement until the transition is complete. Mounting a volume over the old path hides the original files. Removing the original container can remove its writable layer.
3. If the original instance is healthy, create an encrypted backup using the application. Keep its password and current environment-managed secrets in secure custody. Record its timestamp and validate it against the [backup coverage and restore contract](BACKUPS.md). Backups carry durable configuration and authentication, encrypted values and specified safety records. A logical restore ends sessions and may omit caches, leases or bounded history. Preserve filesystem backups, deployment settings and secrets separately.
4. Initialize a separate destination with a newly configured empty persistent directory and its own storage binding. Keep this destination isolated from upstream services and away from users during verification. Use the supported application restore, verify the committed outcome, sign in again, and confirm that the expected configuration, credentials and protected records are present. Keep the source and backup intact until acceptance. Move service traffic only after the old actor is stopped and the destination has been accepted.
5. If the original cannot start, an applicable verified backup can support the same procedure as of the backup's timestamp. Without one, preserve the original and seek operator-reviewed recovery. There is no verified general offline rebind procedure. Keep existing journals and coordination files intact.

A copied protocol-v1 database and its sidecars carry the original physical binding. Copying them into a fresh mount cannot establish that binding's continuity. Startup may also refuse after an identity change on a previously working mount. Keep the original storage and backups so those cases can be investigated without losing the only source.
