#!/bin/sh
# Keep the kernel lock in the API process for its entire lifetime. Never remove
# this file: replacing its inode would allow a second independent lock.
set -eu
data_dir=${DATA_DIR:-/data}
mkdir -p "$data_dir"
command -v flock >/dev/null 2>&1 || {
  echo 'openGym requires util-linux flock for exclusive data ownership' >&2
  exit 1
}
script_dir=$(CDPATH='' cd -- "$(dirname -- "$0")" && pwd)
export OPENGYM_WRITER_LOCK=1
# --no-fork makes node the lock holder and preserves PID 1/signal behavior.
# Contention exits 73 before server.js can generate secrets or write any data.
exec flock --exclusive --nonblock --conflict-exit-code 73 --no-fork \
  "$data_dir/.writer.lock" node "$script_dir/server.js"
