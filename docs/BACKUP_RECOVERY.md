# Backup and recovery for the single-writer deployment

The starting service objective is **RPO at most 24 hours** and **RTO at most 2 hours** for a
small household instance, with planned downtime for each backup. These are targets, not
measured guarantees. Before accepting production data, measure a complete restore at the
expected volume size, record the result and change the targets/schedule if needed. Alert when
the latest successful backup is 24 hours old, any scheduled backup fails, or a restore drill
is overdue. Run a restore drill before every release/storage migration and at least monthly.
An operator owns these alerts; a successful archive command alone is not acceptance.

## Storage prerequisites

Choose an explicit CSI StorageClass with documented file and directory `fsync`, atomic rename,
volume attachment/fencing, encryption, topology and failure recovery behavior. Use retained
volumes (`reclaimPolicy: Retain`) and separately controlled snapshot retention; verify actual
settings on the provisioned PV, rather than relying on cluster defaults. Test durable writes,
node loss and restore on that driver. Enforce one writer; never force-delete a pod or clear a
writer lock while its old node might still write. CSI snapshots are optional accelerators,
not the only recovery copy. A snapshot on the same failed storage system is insufficient.

Account/profile and Coach JSON replacements now sync the temporary file, rename, then sync
the parent directory before returning success. New Coach directories also sync their parent.
Files default to mode 0600. Unsupported/failed fsync fails the write. If directory sync fails
after rename, the result is uncertain; inspect/reread before retrying. This does not make
multi-file changes transactional or guarantee a storage controller honors flushes. Media
uploads, deletion and append-only audit writes have separate durability behavior. Complete
quiesced backups remain necessary even with these stronger JSON write acknowledgements.

## Encrypted off-volume repository

Use a maintained, pinned restic release (helper exercised with 0.18.0 or newer), `node`, Bash,
`flock` and `realpath` in a reviewed maintenance image/host. Keep this environment and scripts
outside the application volume. Restic encrypts repository contents; initialize it with a
random strong password stored outside the PVC and escrowed separately for disaster recovery.
Use an off-node/off-volume backend, preferably a separate account/failure domain with object
retention or an append-only service. Require TLS or authenticated SSH. Grant backup operators
only required access, use separate prune credentials, and restrict secret/log access. Backup
files include both encrypted Coach credentials **and their decryption secret**.

Set `RESTIC_REPOSITORY` (for example your HTTPS S3 repository) and
`RESTIC_PASSWORD_FILE` pointing to a mounted 0400 secret, plus backend credentials through a
secret manager. Never put the password in command arguments, Git, logs or the application
PVC. Run `restic init` once in the controlled environment; preserve credentials in the DR
vault. Validate credentials and `restic snapshots` before scheduling downtime.
See the [restic repository documentation](https://restic.readthedocs.io/en/stable/030_preparing_a_new_repo.html).

## Scheduled, quiesced backup

Schedule this complete procedure daily at 02:00 in the operator's chosen timezone using the
cluster's approved maintenance scheduler. Do not schedule a bare live `restic backup` or
`tar` job. Serialize maintenance, disable GitOps/autoscaler reconciliation during the window,
and notify users that uploads/jobs may be interrupted. The current API does not provide a
cross-file quiesce API: block ingress/new jobs, allow active work to finish where practical,
and stop the entire deployment. Provider calls already in flight can still incur charges.

```bash
kubectl -n fitness scale deployment/opengym --replicas=0
kubectl -n fitness wait --for=delete pod -l app=opengym --timeout=10m
kubectl -n fitness get pods -l app=opengym
```

Confirm no matching pods, no other workload mounting the data PVC, and no partitioned old
node retaining access. A timeout is a failed quiesce: investigate, never force removal merely
to take a backup. Only then mount the data PVC in the maintenance environment (RWOP requires
the application pod to be gone). Use the runtime UID or approved offline ownership migration
so private files are readable; do not broaden their permissions.

```bash
OPENGYM_QUIESCED=1 scripts/backup/opengym-backup.sh backup /data
restic snapshots --host opengym --tag opengym-complete
```

`OPENGYM_QUIESCED=1` records the operator's verified precondition; it cannot prove remote
writers are gone. The helper also holds `/data/.writer.lock` exclusively for the entire
validation/backup, interoperating with the single-writer startup wrapper. Never remove,
truncate or replace that lock inode on an active volume. Older releases without the wrapper
still require verified shutdown. All exit failures, including restic's partial-backup status,
fail the scheduled task. Record snapshot ID, timestamp, release image digests, account/profile
and file/byte counts, duration and PV/StorageClass in the protected operations record.

Unmount/delete the maintenance pod before scaling the application back to one replica,
restore reconciliation, verify sign-in/read/write/media, then re-enable traffic. On any backup
failure, alert and diagnose before a controlled restart; do not mark the run successful.
Monitor backup duration because the service is unavailable for the entire copy.

Daily keep 7 snapshots, weekly 5 and monthly 12 as an initial retention policy. Run retention
with separate maintenance credentials only after a successful backup and recent restore drill:

```bash
restic forget --host opengym --tag opengym-complete --group-by host,paths,tags \
  --keep-daily 7 --keep-weekly 5 --keep-monthly 12 --dry-run
# Review the candidates, then run the same command without --dry-run.
# Schedule restic prune separately, honoring backend retention and capacity.
restic check --read-data
```

`check --read-data` verifies repository data; budget for transfer/cost and run at least monthly.
Keep immutability/retention appropriate to the backend: application/backup credentials must
not permit an attacker to erase every recovery point. See [repository checks](https://restic.readthedocs.io/en/stable/045_working_with_repos.html).

## Restore and acceptance drill

1. Fence/stop production before any recovery cutover. Preserve the failing volume unchanged.
   Provision a **new** isolated encrypted volume/environment with no public route, push delivery
   or provider egress. Disable Coach with `COACH_DISABLED=1`; prevent reminder delivery by
   egress policy. Pin the release matching the chosen snapshot before testing an upgrade.
2. Select an explicit snapshot ID from `restic snapshots`; inspect `restic ls SNAPSHOT_ID` and
   the recorded counts/digests. Do not select an unfiltered `latest` or mix snapshot contents.
3. Restore into a nonexistent target directory on the new volume. `/data` below is the path
   that was backed up, not the active production mount:

   ```bash
   scripts/backup/opengym-backup.sh restore SNAPSHOT_ID /data /new-volume/restored
   ```

   The helper refuses existing targets, verifies restored file contents through restic, checks
   required account/signing/push files and profile shapes, and decrypts existing Coach
   credential blobs without printing them. Failed restores remain isolated for investigation.
   Compare recorded file/byte/profile counts with validator output and the snapshot listing.
   Run the stricter release-specific offline integrity validator too when supplied by that
   release (`node api/scripts/validate-storage.js /new-volume/restored`). Missing files cannot
   be inferred solely from structural validation. See [restic restore semantics](https://restic.readthedocs.io/en/stable/050_restore.html).
4. Verify ownership/private modes for the deployment UID before mounting at `/data`. Start
   one isolated API/web pair and exercise a test account's passkey/password sign-in, expected
   workout history and revision, a round-trip state update, representative uploaded photos/
   videos, and Coach credential status. Browser passkeys need the original RP ID and an
   approved isolated origin/DNS test arrangement. Verify all expected media references, not
   just a sample, for formal recovery acceptance. Never contact paid providers during a drill.
5. The separate optional `coach-auth` CLI credential directory is deliberately excluded from
   application data backups. Reauthenticate the CLI provider explicitly if that runtime is
   used. Record this time in RTO. Downloadable exercise assets on the other PVC can be rebuilt;
   mirror/preserve their pinned artifact if upstream availability would exceed the RTO.
6. Record elapsed restore/validation/cutover time and the recovered snapshot age, errors and
   corrections. Only after acceptance remount the validated volume as the sole production
   data store and restore traffic. Retain the previous volume/snapshot until the rollback
   window expires. Never copy a restored lockfile onto a volume that still has a writer.

A passing local helper test is not a demonstrated cluster recovery. CSI behavior, off-site
credentials, capacity, actual Gateway/DNS, pod termination and node fencing must all be
exercised in the deployment environment before these objectives can be claimed.
