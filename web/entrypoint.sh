#!/bin/sh
set -eu
umask 077
mkdir -p /tmp/nginx
# Substitute only deployment variables; nginx's $uri/$host/etc must stay intact.
# shellcheck disable=SC2016
envsubst '${NGINX_PORT} ${BACKEND} ${PORT} ${RESOLVER} ${CF_CONNECTING_IP} ${BASE_PATH} ${MEDIA_UPLOAD_MAX}' \
  < /etc/nginx/templates/default.conf.template > /tmp/nginx/default.conf
exec "$@"
