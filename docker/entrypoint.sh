#!/bin/sh
set -eu

PUID=${PUID:-1000}
PGID=${PGID:-1000}

groupmod -o -g "$PGID" node
usermod -o -u "$PUID" node
mkdir -p "${CUE_DATA_DIR:-/data}" "${CUE_WORKSPACE:-/workspace}"
find -P "${CUE_DATA_DIR:-/data}" -xdev \( ! -uid "$PUID" -o ! -gid "$PGID" \) -exec chown -h node:node -- {} +
if [ -z "$(ls -A "${CUE_WORKSPACE:-/workspace}")" ]; then
  chown node:node "${CUE_WORKSPACE:-/workspace}"
fi

export HOME=/home/node
exec gosu node node /app/docker/host.mjs
