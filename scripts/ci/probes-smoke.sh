#!/bin/sh
# Built-image probe contract: success is quiet; real traffic and failures stay visible.
# CONTAINER_RUNTIME=podman scripts/ci/probes-smoke.sh api-image web-image
set -eu
runtime=${CONTAINER_RUNTIME:-docker}
api_image=${1:?API image required}
web_image=${2:?web image required}
suffix="$$"
api="opengym-probe-api-$suffix"
web="opengym-probe-web-$suffix"
network="opengym-probe-$suffix"
cleanup() {
    "$runtime" rm -f "$web" "$api" >/dev/null 2>&1 || true
    "$runtime" network rm "$network" >/dev/null 2>&1 || true
}
trap cleanup EXIT INT TERM
"$runtime" network create "$network" >/dev/null
"$runtime" run -d --name "$api" --network "$network" --tmpfs /data:rw,mode=1777 "$api_image" >/dev/null
# Resolve once only for the test's literal-IP configuration; DNS/IPv6 gets its own suite.
backend=$("$runtime" inspect -f '{{range .NetworkSettings.Networks}}{{.IPAddress}}{{end}}' "$api")
"$runtime" run -d --name "$web" --network "$network" -e BACKEND="$backend" -e BASE_PATH=/gym -e NGINX_PORT=8080 -p 127.0.0.1::8080 "$web_image" >/dev/null
address=$("$runtime" port "$web" 8080/tcp | head -1)
base="http://$address"
status() {
    python3 - "$base$1" <<'PY'
import sys, urllib.request, urllib.error
try:
    with urllib.request.urlopen(sys.argv[1], timeout=5) as response:
        print(response.status)
except urllib.error.HTTPError as error:
    print(error.code)
except (OSError, urllib.error.URLError):
    print(0)
PY
}
wait_ready() {
    tries=0
    until [ "$(status /readyz)" = 200 ]; do
        tries=$((tries + 1))
        if [ "$tries" -ge 30 ]; then
            "$runtime" logs "$api"
            "$runtime" logs "$web"
            exit 1
        fi
        sleep 1
    done
}
wait_ready
for _ in 1 2 3; do
    [ "$(status /healthz)" = 200 ]
    [ "$(status /readyz)" = 200 ]
done
[ "$(status /gym/)" = 200 ]
[ "$(status /gym/missing-probe-test.png)" = 404 ]
logs=$("$runtime" logs "$web" 2>&1)
if printf '%s\n' "$logs" | grep -E 'GET /(healthz|readyz) HTTP/[^ ]+" 200'; then
    echo 'Successful probes leaked into access logs' >&2
    exit 1
fi
printf '%s\n' "$logs" | grep -E 'GET /gym/ HTTP/[^ ]+" 200' >/dev/null
printf '%s\n' "$logs" | grep -E 'GET /gym/missing-probe-test.png HTTP/[^ ]+" 404' >/dev/null
"$runtime" pause "$api" >/dev/null
[ "$(status /healthz)" = 200 ]
case "$(status /readyz)" in
    502|504) ;;
    *) echo 'Readiness passed or returned an unexpected status with the API paused' >&2; exit 1 ;;
esac
"$runtime" logs "$web" 2>&1 | grep -E 'GET /readyz HTTP/[^ ]+" 50[24]' >/dev/null
"$runtime" unpause "$api" >/dev/null
wait_ready
# A live proxy with an unreadable application is not ready. This image's nginx
# workers are unprivileged even before K8S-03 changes the container's parent UID.
"$runtime" exec -u 0 "$web" chmod 000 /usr/share/nginx/html/index.html
[ "$(status /healthz)" = 200 ]
[ "$(status /readyz)" = 403 ]
"$runtime" logs "$web" 2>&1 | grep -E 'GET /readyz HTTP/[^ ]+" 403' >/dev/null
"$runtime" exec -u 0 "$web" chmod 644 /usr/share/nginx/html/index.html
wait_ready
printf '%s\n' 'Probe smoke passed: quiet successes, visible requests/failures, backend and shell failure/recovery.'
