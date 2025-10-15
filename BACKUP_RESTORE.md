# Backup & Restore Guide

This guide covers the built-in encrypted backup and restore functionality in Arr Dashboard.

## Table of Contents

- [Overview](#overview)
- [Features](#features)
- [Creating a Backup](#creating-a-backup)
- [Restoring from Backup](#restoring-from-backup)
- [Backup File Format](#backup-file-format)
- [Security](#security)
- [Best Practices](#best-practices)
- [Troubleshooting](#troubleshooting)
- [API Usage](#api-usage)

## Overview

Arr Dashboard includes a built-in backup and restore system that allows you to:

- **Export** your entire configuration (database + secrets) as an encrypted file
- **Restore** from a backup to migrate between installations or recover from issues
- **Secure** your data with AES-256-GCM encryption and password-based encryption

The backup system is designed to be simple, secure, and portable across different installations.

## Features

- ✅ **Encrypted Backups** - AES-256-GCM encryption with PBKDF2 key derivation
- ✅ **Complete Backup** - Includes all database data and encryption keys
- ✅ **Password Protected** - Choose your own backup password (not stored anywhere)
- ✅ **Portable** - Works across different servers and Docker installations
- ✅ **Version Tracking** - Backups include app version and timestamp metadata
- ✅ **Automatic Restart** - App automatically restarts after restore in production
- ✅ **Manual Restart** - Separate endpoint for manual application restarts

### What's Included in Backups

A backup includes:

**Database Tables:**
- User accounts (passwords, TMDB API keys)
- User sessions
- Service instances (Sonarr/Radarr/Prowlarr configurations)
- Service tags
- OIDC provider configurations
- OIDC account links
- WebAuthn passkey credentials

**Secrets:**
- Encryption key (for service API keys)
- Session cookie secret

**Metadata:**
- App version at backup time
- Backup timestamp
- Data size

## Creating a Backup

### Via Web UI (Recommended)

1. **Login** to your Arr Dashboard
2. Navigate to **Settings → Account** (or **Settings → Backup** if there's a dedicated tab)
3. Scroll to the **Backup & Restore** section
4. Enter a **strong password** for encrypting the backup
5. Click **Create Backup**
6. The encrypted backup file will be downloaded automatically

**Filename Format:**
```
arr-dashboard-backup-2025-10-14T12-30-00-000Z.enc
```

### Via API

```bash
curl -X POST http://localhost:3000/api/backup/create \
  -H "Content-Type: application/json" \
  -H "Cookie: arr_session=your-session-cookie" \
  -d '{"password": "your-strong-password"}' \
  -o backup.enc
```

## Restoring from Backup

### Via Web UI (Recommended)

1. **Login** to your Arr Dashboard (or create a new account if fresh install)
2. Navigate to **Settings → Account** (or **Settings → Backup**)
3. Scroll to the **Backup & Restore** section
4. Click **Choose File** and select your `.enc` backup file
5. Enter the **password** you used when creating the backup
6. Click **Restore Backup**
7. Wait for the restore to complete

**After Restore:**

- **Production/Docker**: The application will automatically restart in a few seconds
- **Development**: You'll see a message to manually restart the server

### Via API

```bash
# First, read the backup file as base64
BACKUP_DATA=$(base64 -w 0 backup.enc)  # Linux/Mac
# OR
BACKUP_DATA=$(certutil -encode backup.enc -encodehex | findstr /v CERTIFICATE)  # Windows

# Then restore
curl -X POST http://localhost:3000/api/backup/restore \
  -H "Content-Type: application/json" \
  -H "Cookie: arr_session=your-session-cookie" \
  -d "{\"encryptedBackup\": \"$BACKUP_DATA\", \"password\": \"your-strong-password\"}"
```

### Important Notes

#### Automatic Restart

After a successful restore, the application will:

1. **Production/Docker**: Automatically restart within 1-2 seconds
   - The container must have a restart policy (`restart: unless-stopped`)
   - Or be managed by a process manager (pm2, systemd, etc.)

2. **Development**: Show a message to manually restart
   - Stop the dev server (Ctrl+C)
   - Run `pnpm run dev` again

#### Session Expiration

- Your current session will be invalidated after restore
- You'll need to log back in with the restored credentials
- Any active sessions from the backup will be restored

#### Data Overwrite

- **⚠️ Warning**: Restore completely overwrites your current database
- All existing data will be replaced with the backup data
- This action cannot be undone - create a backup first if needed

## Backup File Format

### Structure

Backups use a layered encryption approach:

```
┌─────────────────────────────────────────┐
│  Encrypted Container (.enc file)        │
│  ┌───────────────────────────────────┐  │
│  │ Salt (32 bytes)                   │  │
│  │ IV (16 bytes)                     │  │
│  │ Auth Tag (16 bytes)               │  │
│  │ Encrypted Payload                 │  │
│  │  ┌─────────────────────────────┐  │  │
│  │  │ JSON Backup Data            │  │  │
│  │  │ - version: "1.0"            │  │  │
│  │  │ - appVersion: "2.2.0"       │  │  │
│  │  │ - timestamp: "2025-10-14..." │  │  │
│  │  │ - data: { ... }             │  │  │
│  │  │ - secrets: { ... }          │  │  │
│  │  └─────────────────────────────┘  │  │
│  └───────────────────────────────────┘  │
└─────────────────────────────────────────┘
```

### Encryption Details

**Algorithm**: AES-256-GCM (Galois/Counter Mode)
- **Encryption**: AES-256 block cipher
- **Authentication**: GMAC for data integrity
- **Mode**: GCM combines encryption and authentication

**Key Derivation**: PBKDF2
- **Iterations**: 100,000
- **Key Length**: 32 bytes (256 bits)
- **Digest**: SHA-256
- **Salt**: 32 random bytes (unique per backup)

**Encoding**: Base64
- The entire encrypted container is base64-encoded for safe transmission

### Version Compatibility

**Current Backup Version**: `1.0`

The backup system includes version checks:
- Backups from unsupported versions will be rejected
- App version is stored for reference (e.g., "2.2.0")
- Future versions may support migration from older backup formats

## Security

### Password Security

**Choosing a Strong Password:**
- Use at least 16 characters
- Mix uppercase, lowercase, numbers, and symbols
- Don't reuse your login password
- Consider using a password manager

**Password Storage:**
- ⚠️ **Your backup password is NOT stored anywhere**
- You must remember it or store it securely
- Lost passwords = unrecoverable backups

### Encryption Strength

**Industry Standard:**
- AES-256-GCM is used by:
  - U.S. Government for classified information
  - Major cloud providers (AWS, Google, Azure)
  - Signal, WhatsApp, and other secure messaging apps

**Key Derivation:**
- PBKDF2 with 100,000 iterations makes brute-force attacks impractical
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

**Important Security Consideration:**

Backup files contain the encryption keys used to decrypt service API keys stored in the database. This is intentional and follows industry-standard practices for self-hosted applications.

**Why Encryption Keys Are Included:**

1. **Complete Portability**: Backups can be restored on any server without manual key management
2. **Industry Standard**: Other self-hosted applications (Sonarr, Radarr, Prowlarr) store API keys in plain text in their databases
3. **Security Perimeter**: The backup password is the security boundary - it protects all data including keys
4. **Practical Security**: Without this approach, backups would be incomplete and unusable for disaster recovery

**Security Implications:**

- **Your backup password is the master key** - Anyone with the password can decrypt ALL data
- The backup file is as sensitive as the password you choose to protect it
- Service API keys are protected by TWO layers: the backup encryption password AND the included encryption key
- This is more secure than how most self-hosted apps handle API keys (which store them in plain text)

**Best Practices:**

1. **Use a very strong backup password** (minimum 16 characters)
2. **Store backups securely** - treat them as highly sensitive data
3. **Physical/filesystem security** - Ensure your backup storage location is secure
4. **Regular rotation** - Create new backups periodically and securely delete old ones
5. **Access control** - Limit who has access to backup files and passwords

**Comparison with Other Applications:**

- **Sonarr/Radarr/Prowlarr**: Store all API keys in plain text in SQLite database
- **Arr Dashboard**: Encrypts API keys in database, then encrypts entire backup including keys
- **Result**: Arr Dashboard provides double encryption for API keys in backups

**The Bottom Line:**

Including encryption keys in backups is the correct approach for a self-hosted application. The backup password is your security perimeter - choose it wisely and protect it like you would protect access to your entire system.

### Storage Recommendations

1. **Store backups securely**:
   - Encrypted cloud storage (Google Drive, Dropbox, etc.)
   - Password-protected USB drives
   - Secure network storage

2. **Multiple copies** (3-2-1 rule):
   - 3 total copies of your data
   - 2 different storage types
   - 1 off-site backup

3. **Regular testing**:
   - Periodically test restoring from backup
   - Verify backups aren't corrupted

## Best Practices

### When to Create Backups

**Before:**
- Major version upgrades
- Changing authentication settings
- Adding/removing multiple services
- Database migrations

**Regular Schedule:**
- Weekly for active setups
- Monthly for stable setups
- After significant configuration changes

### Backup Rotation

Keep multiple backup generations:
- Latest daily backup
- Weekly backups for the last month
- Monthly backups for 6-12 months

Example naming:
```
backups/
├── daily/
│   ├── arr-dashboard-backup-2025-10-14.enc
│   ├── arr-dashboard-backup-2025-10-13.enc
│   └── arr-dashboard-backup-2025-10-12.enc
├── weekly/
│   └── arr-dashboard-backup-2025-W42.enc
└── monthly/
    └── arr-dashboard-backup-2025-10.enc
```

### Migration Workflow

**Moving to a new server:**

1. **Old Server:**
   - Create a backup
   - Verify backup downloaded successfully
   - Note your backup password

2. **New Server:**
   - Install Arr Dashboard (Docker recommended)
   - Complete initial setup (create any user)
   - Restore from backup
   - Application will restart with migrated data

3. **Verification:**
   - Login with your original credentials
   - Check service connections
   - Verify TMDB API key (if set)
   - Test authentication methods (OIDC, passkeys)

### Automation Ideas

**Scheduled Backups (Advanced):**

```bash
#!/bin/bash
# backup-arr-dashboard.sh
# Schedule with cron: 0 2 * * * /path/to/backup-arr-dashboard.sh

SESSION_COOKIE="your-session-cookie"
PASSWORD="your-backup-password"
BACKUP_DIR="/backups/arr-dashboard"
DATE=$(date +%Y-%m-%d)

curl -X POST http://localhost:3000/api/backup/create \
  -H "Content-Type: application/json" \
  -H "Cookie: arr_session=$SESSION_COOKIE" \
  -d "{\"password\": \"$PASSWORD\"}" \
  -o "$BACKUP_DIR/backup-$DATE.enc"

# Keep only last 7 days
find "$BACKUP_DIR" -name "backup-*.enc" -mtime +7 -delete
```

**Note**: Store session cookies and passwords securely (environment variables, secrets management).

## Manual Restart

The application provides a dedicated restart endpoint for manual restarts:

### Via API

```bash
curl -X POST http://localhost:3000/api/system/restart \
  -H "Cookie: arr_session=your-session-cookie"
```

**Response:**
```json
{
  "success": true,
  "message": "The application will restart automatically in a few seconds..."
}
```

### When to Use

- After changing environment variables
- When troubleshooting issues
- After manual database changes
- Testing restart functionality

### Rate Limiting

The restart endpoint is rate-limited for security:
- **Maximum**: 2 requests per 5 minutes
- **Purpose**: Prevents restart loops and abuse
- **Authentication**: Required

## Troubleshooting

### Backup Creation Issues

#### "Failed to create backup"

**Causes:**
- Database connection issues
- Disk space full
- Permission errors on secrets file

**Solutions:**
```bash
# Check disk space
df -h

# Check database file permissions (Docker)
docker exec arr-dashboard ls -la /app/data/

# Check logs
docker logs arr-dashboard
```

#### "Backup file too large"

**Cause**: Large database (many services, history, etc.)

**Solutions:**
- Database size is normal for large setups
- Ensure adequate network bandwidth for download
- Consider compressing backup file externally if needed

### Restore Issues

#### "Invalid password or corrupted backup file"

**Causes:**
- Wrong password entered
- Backup file corrupted during download/transfer
- Backup file modified

**Solutions:**
- Double-check password (case-sensitive)
- Re-download backup file
- Verify file integrity (compare file size)

#### "Unsupported backup version"

**Cause**: Backup from newer/older incompatible version

**Solution:**
- Update Arr Dashboard to latest version
- Check release notes for migration guidance

#### "Invalid backup format"

**Causes:**
- Corrupted file
- Not a valid backup file
- File truncated during transfer

**Solutions:**
- Verify file is complete (check file size)
- Use binary mode for file transfers (not text mode)
- Try re-downloading the backup

### Restart Issues

#### "Application not restarting after restore (Docker)"

**Cause**: Container doesn't have restart policy

**Solution:**
```yaml
# docker-compose.yml
services:
  arr-dashboard:
    image: khak1s/arr-dashboard:latest
    restart: unless-stopped  # Add this line
```

#### "Application not restarting after restore (Manual)"

**Cause**: Development mode without process manager

**Solution:**
- Development: Manually restart with `pnpm run dev`
- Production: Use process manager (pm2, systemd)
- Or use the built-in launcher: `pnpm run dev:launcher`

#### "Manual restart not working"

**Possible Causes:**
- Not authenticated
- Rate limit exceeded (2 per 5 minutes)
- Server configuration issues

**Check:**
```bash
# View logs
docker logs arr-dashboard

# Check authentication
curl -X GET http://localhost:3000/auth/me \
  -H "Cookie: arr_session=your-session-cookie"
```

### Database Issues After Restore

#### "Database is locked"

**Cause**: Multiple processes accessing database

**Solution:**
```bash
# Docker: Ensure only one container is running
docker ps | grep arr-dashboard

# Stop any duplicates
docker stop <container-id>
```

#### "Session expired immediately after restore"

**Expected Behavior**: Sessions from the NEW database are restored, your OLD session is invalidated.

**Solution**: Log in again with credentials from the backup.

### File Transfer Issues

#### "Backup file won't upload"

**Causes:**
- File too large for web server limits
- Network timeout
- Browser limitations

**Solutions:**
- Use API endpoint instead of web UI
- Adjust upload limits (nginx, etc.)
- Split restore into smaller operations (advanced)

## API Usage

### Endpoints

#### Create Backup

**Endpoint**: `POST /api/backup/create`

**Request:**
```json
{
  "password": "your-strong-password"
}
```

**Response:**
```json
{
  "encryptedBackup": "base64-encoded-backup-data",
  "metadata": {
    "version": "1.0",
    "appVersion": "2.2.0",
    "timestamp": "2025-10-14T12:30:00.000Z",
    "dataSize": 12345
  },
  "filename": "arr-dashboard-backup-2025-10-14T12-30-00-000Z.enc"
}
```

**Rate Limit**: 3 requests per 5 minutes

#### Restore Backup

**Endpoint**: `POST /api/backup/restore`

**Request:**
```json
{
  "encryptedBackup": "base64-encoded-backup-data",
  "password": "your-strong-password"
}
```

**Response:**
```json
{
  "success": true,
  "message": "Backup restored successfully. The application will restart automatically in a few seconds...",
  "restoredAt": "2025-10-14T12:35:00.000Z",
  "metadata": {
    "version": "1.0",
    "appVersion": "2.2.0",
    "timestamp": "2025-10-14T12:30:00.000Z",
    "dataSize": 12345
  }
}
```

**Rate Limit**: 2 requests per 5 minutes

#### Manual Restart

**Endpoint**: `POST /api/system/restart`

**Request**: No body required

**Response:**
```json
{
  "success": true,
  "message": "The application will restart automatically in a few seconds..."
}
```

**Rate Limit**: 2 requests per 5 minutes

### Authentication

All backup/restore/restart endpoints require authentication:

**Cookie-based** (web UI):
```
Cookie: arr_session=your-session-token
```

**Example with curl**:
```bash
# Login first to get session cookie
curl -X POST http://localhost:3000/auth/login \
  -H "Content-Type: application/json" \
  -d '{"username": "admin", "password": "your-password"}' \
  -c cookies.txt

# Use cookie for backup
curl -X POST http://localhost:3000/api/backup/create \
  -H "Content-Type: application/json" \
  -b cookies.txt \
  -d '{"password": "backup-password"}' \
  -o backup.enc
```

### Error Responses

**400 Bad Request**:
```json
{
  "error": "Invalid request",
  "details": "Password is required"
}
```

**401 Unauthorized**:
```json
{
  "error": "Unauthorized"
}
```

**429 Too Many Requests**:
```json
{
  "statusCode": 429,
  "error": "Too Many Requests",
  "message": "Rate limit exceeded"
}
```

**500 Internal Server Error**:
```json
{
  "error": "Failed to create backup",
  "details": "Error message details"
}
```

## Additional Resources

- [Main README](README.md) - General setup and configuration
- [Authentication Guide](AUTHENTICATION.md) - OIDC and passkey setup
- [Unraid Deployment](UNRAID_DEPLOYMENT.md) - Unraid-specific instructions
- [Project Documentation](CLAUDE.md) - Technical architecture

## Support

For issues with backup/restore:

1. Check this troubleshooting guide first
2. Review container/server logs
3. Open an issue on GitHub with:
   - App version
   - Deployment method (Docker/manual)
   - Error messages
   - Steps to reproduce

**⚠️ Security Note**: Never share your backup files or passwords when seeking support!

---

**Last Updated**: 2025-10-14
**App Version**: 2.2.0+
**Backup Version**: 1.0
