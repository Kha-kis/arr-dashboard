# Backup & Restore Guide

This guide covers the built-in encrypted backup and restore functionality in Arr Dashboard.

## Table of Contents

- [Overview](#overview)
- [Features](#features)
- [Backup Password Configuration](#backup-password-configuration)
- [Creating a Backup](#creating-a-backup)
- [Restoring from Backup](#restoring-from-backup)
- [Automated Backups](#automated-backups)
- [Backup File Format](#backup-file-format)
- [Security](#security)
- [Best Practices](#best-practices)
- [Troubleshooting](#troubleshooting)
- [API Reference](#api-reference)

## Overview

Arr Dashboard includes a built-in backup and restore system that allows you to:

- **Export** your entire configuration (database + secrets) as an encrypted file
- **Restore** from a backup to migrate between installations or recover from issues
- **Automate** backups with configurable intervals and retention
- **Secure** your data with AES-256-GCM encryption and password-based encryption

The backup system is designed to be simple, secure, and portable across different installations.

## Features

- **Encrypted Backups** - AES-256-GCM encryption with PBKDF2 key derivation (600,000 iterations)
- **Complete Backup** - Includes all database data and encryption keys
- **Server-Side Storage** - Backups stored on filesystem for easy management
- **Automated Scheduling** - Configurable backup intervals (hourly, daily, weekly)
- **Retention Policy** - Automatic cleanup of old backups
- **Multiple Backup Types** - Manual, scheduled, and pre-update backups
- **Version Tracking** - Backups include app version and timestamp metadata
- **Automatic Restart** - App automatically restarts after restore in production

### What's Included in Backups

A backup includes:

**Database Tables:**
- User accounts (passwords, TMDB API keys)
- User sessions
- Service instances (Sonarr/Radarr/Prowlarr configurations)
- Service tags and instance-tag mappings
- OIDC provider configuration
- OIDC account links
- WebAuthn passkey credentials

**Secrets:**
- Encryption key (for service API keys)
- Session cookie secret

**Metadata:**
- Backup version (1.0)
- App version at backup time
- Backup timestamp

## Backup Password Configuration

### Production (Docker)

In production, you **must** set the `BACKUP_PASSWORD` environment variable:

```yaml
services:
  arr-dashboard:
    image: khak1s/arr-dashboard:latest
    environment:
      - BACKUP_PASSWORD=your-very-strong-password-here
    volumes:
      - ./config:/config
```

Without this variable, backup operations will fail in production with:
> "FATAL: BACKUP_PASSWORD environment variable is required in production."

### Development

In development mode, a secure random password is automatically generated and stored in `secrets.json`. You don't need to configure anything.

### Password Requirements

- Use at least 16 characters
- Mix uppercase, lowercase, numbers, and symbols
- Store this password securely - **you'll need it to restore backups**

## Creating a Backup

### Via Web UI (Recommended)

1. **Login** to your Arr Dashboard
2. Navigate to **Settings → Backup**
3. Click **Create Backup**
4. The backup is created and stored on the server

### Via API

```bash
curl -X POST http://localhost:3000/api/backup/create \
  -H "Content-Type: application/json" \
  -H "Cookie: arr_session=your-session-cookie" \
  -d '{}'
```

### Backup Storage Location

Backups are stored in `/config/backups/` organized by type:
```
/config/backups/
├── manual/       # Manually created backups
├── scheduled/    # Automated backups
└── update/       # Pre-update backups
```

**Filename Format:**
```
arr-dashboard-backup-2025-10-14T12-30-00-000Z.json
```

## Restoring from Backup

### Via Web UI (Recommended)

**Option 1: From Server-Stored Backup**
1. Navigate to **Settings → Backup**
2. View the list of available backups
3. Click **Restore** on the desired backup
4. Confirm the restore operation

**Option 2: Upload Backup File**
1. Navigate to **Settings → Backup**
2. Click **Upload Backup**
3. Select your backup `.json` file
4. Confirm the restore operation

### Via API

**From Server-Stored Backup:**
```bash
curl -X POST http://localhost:3000/api/backup/restore-from-file \
  -H "Content-Type: application/json" \
  -H "Cookie: arr_session=your-session-cookie" \
  -d '{"id": "backup-id-here"}'
```

**From Uploaded File:**
```bash
# Base64 encode the backup file
BACKUP_DATA=$(base64 -w 0 backup.json)

curl -X POST http://localhost:3000/api/backup/restore \
  -H "Content-Type: application/json" \
  -H "Cookie: arr_session=your-session-cookie" \
  -d "{\"backupData\": \"$BACKUP_DATA\"}"
```

### After Restore

- **Production/Docker**: The application will automatically restart within a few seconds
- **Development**: You'll see a message to manually restart the server
- Your current session will be invalidated - log in with restored credentials

**Important**: Restore completely overwrites your current database. Create a backup first if needed.

## Automated Backups

### Configuration

Configure automated backups in **Settings → Backup**:

| Setting | Options | Description |
|---------|---------|-------------|
| **Enabled** | On/Off | Enable or disable scheduled backups |
| **Interval Type** | Hourly, Daily, Weekly, Disabled | Backup frequency |
| **Interval Value** | 1-N | Multiplier for interval (e.g., every 2 days) |
| **Retention Count** | 1-N | Number of backups to keep (older ones deleted) |

### Via API

**Get Settings:**
```bash
curl http://localhost:3000/api/backup/settings \
  -H "Cookie: arr_session=your-session-cookie"
```

**Update Settings:**
```bash
curl -X PUT http://localhost:3000/api/backup/settings \
  -H "Content-Type: application/json" \
  -H "Cookie: arr_session=your-session-cookie" \
  -d '{
    "enabled": true,
    "intervalType": "DAILY",
    "intervalValue": 1,
    "retentionCount": 7
  }'
```

## Backup File Format

### Structure

Backups use a JSON envelope with encrypted payload:

```json
{
  "version": "1.0",
  "kdfParams": {
    "algorithm": "pbkdf2",
    "hash": "sha256",
    "iterations": 600000,
    "saltLength": 32
  },
  "salt": "base64-encoded-salt",
  "iv": "base64-encoded-iv",
  "tag": "base64-encoded-auth-tag",
  "cipherText": "base64-encoded-encrypted-backup"
}
```

### Encryption Details

**Algorithm**: AES-256-GCM (Galois/Counter Mode)
- **Encryption**: AES-256 block cipher
- **Authentication**: GMAC for data integrity
- **Mode**: GCM combines encryption and authentication

**Key Derivation**: PBKDF2
- **Iterations**: 600,000 (OWASP recommendation for PBKDF2-SHA256)
- **Key Length**: 32 bytes (256 bits)
- **Digest**: SHA-256
- **Salt**: 32 random bytes (unique per backup)

**IV (Initialization Vector)**: 12 bytes (NIST recommended for GCM)

### Version Compatibility

**Current Backup Version**: `1.0`

The backup system includes version checks:
- Backups from unsupported versions will be rejected
- App version is stored for reference
- Future versions may support migration from older backup formats

## Security

### Backup Password Security

**Key Points:**
- Your backup password is stored as `BACKUP_PASSWORD` environment variable
- In development, it's auto-generated and stored in `secrets.json`
- Lost passwords = unrecoverable backups
- Use a strong password (16+ characters)

### Encryption Strength

**Industry Standard:**
- AES-256-GCM is used by U.S. Government, major cloud providers, and secure messaging apps
- PBKDF2 with 600,000 iterations makes brute-force attacks impractical
- Unique salt per backup prevents rainbow table attacks

### What's Protected

**Encrypted in Backup:**
- All database data
- Service API keys (double-encrypted: once in DB, once in backup)
- User passwords (hashed in DB, encrypted in backup)
- OIDC client secrets
- Session secrets
- Encryption keys

### Encryption Keys in Backups

Backup files include the encryption keys used to decrypt service API keys. This is intentional:

1. **Complete Portability**: Backups can be restored on any server
2. **Industry Standard**: Other self-hosted apps store API keys in plain text
3. **Security Perimeter**: The backup password protects all data including keys
4. **Double Encryption**: API keys are encrypted in DB AND encrypted in backup

**Best Practices:**
- Use a very strong backup password (minimum 16 characters)
- Store backups securely - treat them as highly sensitive data
- Limit who has access to backup files and passwords

## Best Practices

### When to Create Backups

**Before:**
- Major version upgrades
- Changing authentication settings
- Adding/removing multiple services
- Database migrations

**Regular Schedule:**
- Use automated backups for consistent protection
- Weekly for active setups
- Monthly for stable setups

### Backup Rotation

Configure retention count based on your needs:
- **Home use**: Keep 3-7 backups
- **Critical data**: Keep 14-30 backups
- **Limited storage**: Keep 2-3 backups

### Migration Workflow

**Moving to a new server:**

1. **Old Server:**
   - Create a manual backup
   - Download the backup file via API or UI
   - Note your `BACKUP_PASSWORD`

2. **New Server:**
   - Install Arr Dashboard with same `BACKUP_PASSWORD`
   - Upload and restore the backup
   - Application will restart with migrated data

3. **Verification:**
   - Login with your original credentials
   - Check service connections
   - Verify TMDB API key (if set)
   - Test authentication methods (OIDC, passkeys)

## Troubleshooting

### Backup Creation Issues

#### "BACKUP_PASSWORD environment variable is required in production"

**Solution:** Set the `BACKUP_PASSWORD` environment variable in your Docker configuration.

#### "Failed to create backup"

**Causes:**
- Database connection issues
- Disk space full
- Permission errors

**Solutions:**
```bash
# Check disk space
df -h

# Check permissions (Docker)
docker exec arr-dashboard ls -la /config/

# Check logs
docker logs arr-dashboard
```

### Restore Issues

#### "Failed to decrypt backup: invalid password or corrupted data"

**Causes:**
- Wrong `BACKUP_PASSWORD` configured
- Backup file corrupted during transfer

**Solutions:**
- Ensure `BACKUP_PASSWORD` matches what was used when backup was created
- Re-download backup file
- Verify file integrity

#### "Unsupported backup version"

**Cause:** Backup from incompatible version

**Solution:**
- Update Arr Dashboard to latest version
- Check release notes for migration guidance

#### "Invalid backup format"

**Causes:**
- Corrupted file
- Not a valid backup file
- File truncated during transfer

**Solutions:**
- Verify file is complete
- Use binary mode for file transfers
- Try re-downloading the backup

### Restart Issues

#### "Application not restarting after restore (Docker)"

**Cause:** Container doesn't have restart policy

**Solution:**
```yaml
services:
  arr-dashboard:
    restart: unless-stopped
```

## API Reference

### List Backups

**Endpoint**: `GET /api/backup`

**Response:**
```json
{
  "backups": [
    {
      "id": "abc123def456",
      "filename": "arr-dashboard-backup-2025-10-14T12-30-00-000Z.json",
      "type": "manual",
      "timestamp": "2025-10-14T12:30:00.000Z",
      "size": 12345
    }
  ]
}
```

### Create Backup

**Endpoint**: `POST /api/backup/create`

**Request:** `{}`

**Response:**
```json
{
  "id": "abc123def456",
  "filename": "arr-dashboard-backup-2025-10-14T12-30-00-000Z.json",
  "type": "manual",
  "timestamp": "2025-10-14T12:30:00.000Z",
  "size": 12345
}
```

**Rate Limit**: 3 requests per 5 minutes

### Restore from Upload

**Endpoint**: `POST /api/backup/restore`

**Request:**
```json
{
  "backupData": "base64-encoded-backup-file-contents"
}
```

**Response:**
```json
{
  "success": true,
  "message": "Backup restored successfully. Please restart the application...",
  "restoredAt": "2025-10-14T12:35:00.000Z",
  "metadata": {
    "version": "1.0",
    "appVersion": "2.6.0",
    "timestamp": "2025-10-14T12:30:00.000Z",
    "dataSize": 12345
  }
}
```

**Rate Limit**: 2 requests per 5 minutes

### Restore from Server File

**Endpoint**: `POST /api/backup/restore-from-file`

**Request:**
```json
{
  "id": "backup-id-from-list"
}
```

**Response:** Same as restore from upload

**Rate Limit**: 2 requests per 5 minutes

### Download Backup

**Endpoint**: `GET /api/backup/:id/download`

**Response:** Binary file download with `Content-Disposition` header

### Delete Backup

**Endpoint**: `DELETE /api/backup/:id`

**Response:**
```json
{
  "success": true,
  "message": "Backup deleted successfully"
}
```

**Rate Limit**: 5 requests per 5 minutes

### Get Backup Settings

**Endpoint**: `GET /api/backup/settings`

**Response:**
```json
{
  "id": 1,
  "enabled": true,
  "intervalType": "DAILY",
  "intervalValue": 1,
  "retentionCount": 7,
  "lastRunAt": "2025-10-14T02:00:00.000Z",
  "nextRunAt": "2025-10-15T02:00:00.000Z",
  "createdAt": "2025-10-01T00:00:00.000Z",
  "updatedAt": "2025-10-14T02:00:00.000Z"
}
```

### Update Backup Settings

**Endpoint**: `PUT /api/backup/settings`

**Request:**
```json
{
  "enabled": true,
  "intervalType": "DAILY",
  "intervalValue": 1,
  "retentionCount": 7
}
```

**Response:** Same as get backup settings

### Error Responses

**400 Bad Request:**
```json
{
  "error": "Invalid request",
  "details": { ... }
}
```

**401 Unauthorized:**
```json
{
  "success": false,
  "error": "Authentication required"
}
```

**404 Not Found:**
```json
{
  "error": "Backup not found"
}
```

**429 Too Many Requests:**
```json
{
  "statusCode": 429,
  "error": "Too Many Requests",
  "message": "Rate limit exceeded"
}
```

**500 Internal Server Error:**
```json
{
  "error": "Failed to create backup"
}
```

## Additional Resources

- [Main README](README.md) - General setup and configuration
- [Authentication Guide](AUTHENTICATION.md) - OIDC and passkey setup
- [Unraid Deployment](UNRAID_DEPLOYMENT.md) - Unraid-specific instructions

## Support

For issues with backup/restore:

1. Check this troubleshooting guide first
2. Review container/server logs
3. Open an issue on GitHub with:
   - App version
   - Deployment method (Docker/manual)
   - Error messages
   - Steps to reproduce

**Security Note**: Never share your backup files or passwords when seeking support!

---

**Last Updated**: 2025-12-16
**App Version**: 2.6.0+
**Backup Version**: 1.0
