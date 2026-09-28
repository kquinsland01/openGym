# Storage integrity recovery

The API refuses to start if an existing account database or profile has invalid JSON,
an invalid root/collection shape, duplicate user IDs or unusable credential references.
A missing database still permits a new installation. Legacy databases may omit `subs`,
`invites` and `deviceLinks`; legacy profiles may omit lists, use null lists, or contain
individual entries that existing readers filter. Existing invalid files are never treated
as empty stores. Read/stat failures after startup return server errors and block state
replacement; operators must stop the instance on integrity errors.

1. Remove external traffic, stop the sole writer, and verify no old pod/process can access
   the volume. Preserve a protected copy/snapshot of the complete damaged volume for analysis.
   Never delete a file simply to make the process start. An absent file cannot be distinguished
   from intentional bootstrap; incomplete restores must be rejected operationally.
2. Diagnose the path and error code in the server log. Correct access/I/O problems without
   altering contents. For damaged contents, restore a known-good complete backup into a
   **new** volume, including `secret`, account/passkey database, profiles, uploads and Coach
   files. Do not splice account IDs or credential records between backups.
3. With no writer running, run `node api/scripts/validate-storage.js /restored/data` from
   the release being restored. Nonzero status blocks startup. This read-only check validates
   the database and every existing profile; it cannot prove a backup contains all expected
   files. Compare the backup manifest and account/profile counts independently.
4. Start an isolated instance, verify expected accounts, sign-in, revisions and media, and
   check Coach credential decryption with the original secret before enabling that feature.
   Block outbound provider calls/push and external access during restore testing. Validate
   against the intended release before restoring production traffic.

Preserve the failing volume until recovery is accepted. Corruption is an operator incident,
not a request to reset the installation. These checks do not provide cross-file transactions,
continuous detection of out-of-band account database edits, filesystem durability or backups.
