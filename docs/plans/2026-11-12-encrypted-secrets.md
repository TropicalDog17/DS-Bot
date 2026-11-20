# Encrypting secrets at rest (optional)

- Date: 2026-11-12
- Related: #1467, [browser, search, secrets and connectors](2026-10-08-browser-and-secrets.md), [connectors](2026-11-04-connectors.md)

## Why

Today a Bot's secrets (`bot/secrets.json`) have only file mode 600, redaction in output and
`$DSH_SECRET_<NAME>` injection; the values themselves are plain text. When a user who self
hosts on a Linux server connects personal mail or connectors, the data directory or a
backup can be copied away, and the plain-text secrets leak with it. Users want to be able
to choose the system keyring or an external secret provider.

First the threat model: **the running process must be able to get the secrets**, so
encryption at rest only protects against "the disk or a backup is copied away". It does
not protect against a compromised running process, or a local administrator who can read
process memory or the passphrase source. This is written into the product judgment and is
not treated as a problem that encryption can solve.

## Options compared

| Option | Pros | Cost |
|---|---|---|
| System keyring (macOS Keychain, Windows DPAPI, Linux Secret Service) | Unlocks with the desktop login; the user does not need to remember a passphrase | Linux without a desktop session has no Secret Service; the plugin process is not the Electron main process and cannot get `safeStorage`; one set of code and failure paths per platform |
| External secret provider interface (Vault and others) | Operators already have secret management | Needs a networked hosted service, which users explicitly do not want; high interface and deployment cost |
| Passphrase-encrypted file (the starting option chosen in this pull request) | No dependencies, no network, works on Linux without a desktop; the change stays in one file | The user must remember a passphrase; an unattended restart needs the passphrase in the service manager |

The passphrase-encrypted file comes first; "system keyring / external provider" is left as
a provider that can be added later. This pull request adds no dependencies and uses no
network.

## Decided behavior

- **Default unchanged**: when encryption is not on, `secrets.json` is today's
  `{version:1,secrets:[...]}`; mode 600, the write method, the API and the interface are
  all as they are now. Existing users need no migration.
- **Opt-in**: the "Encryption at rest" card in Settings → Secrets. The user sets a
  passphrase (at least 8 characters), and **the same file** `secrets.json` is atomically
  replaced with an encrypted envelope. Once it is on, only ciphertext is on disk (secret
  names, values and purposes do not appear in the file).
- **Format**: the content of `secrets.json` becomes
  `{version:2, encrypted:true, kdf:{name:"scrypt",N:32768,r:8,p:1}, salt, iv, tag, ciphertext}`.
  The key is derived with scrypt (N=2^15, r=8, p=1, 16-byte salt) to 32 bytes and used for
  AES-256-GCM with a random 12-byte IV and a 16-byte tag; the plain-text payload is still
  the original `{version:1,secrets:[...]}`. File mode stays 600, and salt and iv are random
  again on every encryption.
- **Unlock**: at start the passphrase is taken in this order: an already unlocked
  passphrase in this process's memory, `DS_BOT_SECRETS_PASSPHRASE`,
  `DS_BOT_SECRETS_PASSPHRASE_FILE` (file content with one trailing newline removed). When
  none is there, the store is "locked": it does not write the file, the secret list is
  empty, the settings page shows an unlock card, and the log gives an actionable hint. It
  never silently acts as if there were no secrets.
- **Unlock in the interface**: enter the passphrase in Settings → Secrets. Unlocking holds
  only for this process; after the process exits it is locked again.
- **Turn encryption off (rollback)**: after the passphrase is entered, the same file is
  atomically written back as plain-text `version:1`. The mode switches only after the
  plain-text write succeeds; on failure the file stays encrypted and the mode does not
  change. Rollback with the passphrase also works while locked.
- **Backups**: once encryption is on, `secrets.json` in the data directory is ciphertext
  and backups can go on as usual. The passphrase must be kept separately; **if the
  passphrase is lost, the secrets cannot be recovered** (no back door, no escrow).
  Plain-text backups made before encryption was turned on must be deleted by the user.
- **Unattended restart**: put the passphrase into the service manager (for example
  systemd `EnvironmentFile` or `LoadCredential`), with `DS_BOT_SECRETS_PASSPHRASE_FILE`
  pointing to a file that only the service user can read. Without a passphrase the service
  still starts, but the secrets are locked, the related tools and connectors report a clear
  reason, and the settings page has an unlock entry.
- **All writes are refused while locked** (adding, changing, deleting secrets), so an empty
  list is never written back over the encrypted file.

## Not done

- No change to third-party connector auth flows; connectors still read the decrypted
  values.
- No secret rotation, passphrase change or automatic relock.
- No networked secret hosting service, no new dependencies.
- No OS keyring (it is a later provider; this pull request gathers the storage layer into
  one module so it is easy to replace later).

## Known limits

- The running process holds the plain-text secrets and the passphrase in memory; the same
  local user or root can read the process, the passphrase environment variable or the
  passphrase file.
- Protection of the passphrase source (environment variable or file) depends on the
  deployment; env is visible to processes of the same user.
- GCM cannot tell whether a failed decryption comes from a wrong passphrase or a damaged
  file, so the message always says both: wrong passphrase or damaged file.
- Leftover copies of the old plain text (backups, logs, other machines) after encryption is
  turned on are outside the scope of this feature.
- The settings page is not supported on mobile (the phone app has no secrets page yet).

## Changes

- 2026-11-12: first version (#1467).
