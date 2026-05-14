#!/bin/sh
set -e

mkdir -p /app/data /app/public/generated /app/public/avatars
chown -R nextjs:nodejs /app/data /app/public/generated /app/public/avatars

exec gosu nextjs "$@"
