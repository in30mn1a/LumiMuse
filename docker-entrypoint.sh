#!/bin/sh
set -e

mkdir -p /app/data /app/public/generated /app/public/avatars /app/public/attachments
chown -R nextjs:nodejs /app/data /app/public/generated /app/public/avatars /app/public/attachments

exec gosu nextjs "$@"
