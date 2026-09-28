# Liveness and readiness

Build and publish API and web images from this branch before applying the updated
Kubernetes manifests. Upstream `1.3.9` does not provide these endpoints. Replace the
example fork `edge` tags with verified immutable digests; no images are published
by changing the manifests. This change depends on K8S-01's startup database/profile
validation. K8S-07 separately adds durable writes for application data.

| Endpoint | Meaning | Response |
| --- | --- | --- |
| API `/api/healthz` | HTTP event loop is responding | 200 `{"ok":true}` |
| API `/api/readyz` | Startup validation completed and storage currently supports saves | 200 or 503 `{"ok":boolean}` |
| API `/api/health` | Compatibility alias for readiness; no account count | Same as `/api/readyz` |
| Web `/healthz` | nginx can respond locally | 200 |
| Web `/readyz` | nginx can open the app shell and reach the API readiness endpoint | 200, or failure status |

All probe responses disable caching. Web operational endpoints remain `/healthz`
and `/readyz` even when `BASE_PATH=/gym`. The upstream uses the same `BACKEND`,
`PORT` and `RESOLVER` as normal API traffic, for either separate Deployments or the
bundled same-pod topology. Readiness strips cookies and authorization headers.
Successful dedicated probes do not produce nginx access lines. Normal application
requests and unsuccessful probes retain access logs, and nginx errors remain visible.
The API logs storage readiness transitions, not each successful probe. This does
not introduce general structured request logging.

Startup rejects malformed/unreadable databases and profiles before listening. An
empty session secret or invalid existing VAPID record also prevents startup; only
a genuinely absent key file is initialized. Never delete corrupt files to force a
successful probe: use [storage recovery](STORAGE_RECOVERY.md).

After startup a single worker checks storage every 10 seconds. Each check creates
one unique private 16-byte temporary file per checked directory, writes and fsyncs
it, renames it, reads the bytes back, removes it, and fsyncs the directory. It never
rewrites a database, profile, or key. Existing secret, VAPID and database files must
remain readable. API/profile and Coach state/config save failures immediately
remove readiness, including background saves; observed filesystem errors within
`DATA_DIR` and profile integrity errors also remove it. A later successful check
can restore readiness. It includes destinations of failed saves and reparses an
observed corrupt database/profile before clearing that failure. A successful write
to an unrelated file cannot clear the failure. At most 32 failed paths are tracked;
an overflow stays unready until an operator repairs the issue and restarts.

The worker has a 1.5-second response deadline. If filesystem I/O stalls, readiness
fails while liveness can respond: subsequent checks are not queued and no workers
are repeatedly spawned. The one pending operation must finish before another can
run. Probe requests only read the cached state, so public traffic cannot increase
the filesystem check rate. A crash during a check may leave a `.readiness-*` file;
remove such files only while the instance is stopped. Filesystems must support
file and directory fsync. A small successful check is evidence of current ability
to save, not a capacity reservation, full integrity scrub, or durability guarantee.

Only observed corrupt profiles are reparsed during recovery; every stored profile
is validated at startup, not on each probe. A new per-file permission failure may
therefore first be detected when that profile is accessed. Application filesystem
calls remain synchronous outside the probe worker: a request already stuck inside
an application write can still block the event loop. This probe change does not
claim to eliminate that pre-existing limitation or replace disk/NFS monitoring.

Kubernetes startup probes allow up to five minutes for API startup and 150 seconds
for nginx. Liveness checks the process only; persistent storage or upstream faults
remove readiness without causing a storage-induced restart loop. The readiness
check removes traffic on its first failed observation. Docker health checks use
readiness, and Compose waits for healthy API startup before starting web. Docker's
health status alone does not restart containers.

Validate images with:

```sh
CONTAINER_RUNTIME=podman scripts/ci/probes-smoke.sh API_IMAGE WEB_IMAGE
node --test api/test/storage-health.test.js api/test/server-health.test.js api/test/server-storage-integrity.test.js
```

Before rollout, repeat failure/recovery tests on the actual CSI/NFS volume with the
configured UID/GID. Verify probe reachability through your CNI/NetworkPolicy and
measure initialization time against the startup budget. This repository's local
checks do not certify those cluster-specific behaviors.
