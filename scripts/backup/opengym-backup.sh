#!/usr/bin/env bash
# Run in a maintenance environment with the application stopped. See docs/BACKUP_RECOVERY.md.
set -euo pipefail
umask 077
here=$(cd -- "$(dirname -- "${BASH_SOURCE[0]}")" && pwd)
: "${RESTIC_REPOSITORY:?Set an encrypted off-volume restic repository}"
: "${RESTIC_PASSWORD_FILE:?Set the path of a separately protected repository password file}"
command -v restic >/dev/null
command -v node >/dev/null
case "${1:-}" in
  backup)
    [[ $# == 2 && ${OPENGYM_QUIESCED:-} == 1 ]] || { echo 'Usage: OPENGYM_QUIESCED=1 opengym-backup.sh backup /mounted/data (all writers must be stopped)' >&2; exit 2; }
    data=$(realpath -e -- "$2")
    [[ -d "$data" && "$data" != / ]] || exit 2
    # Advisory fencing complements verified shutdown. Never truncate, remove or replace this
    # inode: production writers using the single-writer wrapper hold the same lock.
    exec 9>>"$data/.writer.lock"
    flock --exclusive --nonblock 9 || { echo 'A writer/maintenance process still owns the data volume' >&2; exit 1; }
    node "$here/validate-backup.mjs" "$data"
    # Any restic failure, including partial backup exit 3, is a failed backup. Keep all files
    # and keys, including uploads, Coach data, and the harmless unlocked lockfile inode.
    restic backup --host opengym --tag opengym-complete -- "$data"
    ;;
  restore)
    [[ $# == 4 ]] || { echo 'Usage: opengym-backup.sh restore SNAPSHOT_ID SOURCE_PATH NEW_EMPTY_TARGET' >&2; exit 2; }
    snapshot=$2
    source_path=$3
    target=$4
    [[ "$snapshot" =~ ^[a-fA-F0-9]{8,64}$ && "$source_path" == /* && "$source_path" != / ]] || exit 2
    # mkdir without -p refuses existing targets, including symlinks. Never restore over the
    # active volume or its writer lock. A failed restore leaves its target for investigation.
    mkdir -m 700 -- "$target"
    restic restore "$snapshot:$source_path" --target "$target" --verify
    node "$here/validate-backup.mjs" "$target"
    ;;
  *) echo 'Usage: opengym-backup.sh backup DATA | restore SNAPSHOT_ID SOURCE_PATH NEW_TARGET' >&2; exit 2 ;;
esac
