#!/bin/sh
set -e

chown node:node /app/data

exec gosu node "$@"
