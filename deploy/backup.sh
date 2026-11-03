#!/bin/sh
# One compressed dump per night; old ones are pruned. Restore: see docs/DEPLOY.md.
set -eu
stamp=$(date +%Y-%m-%d_%H%M)
pg_dump -h postgres -U postgres -d ambeauty -Fc -f "/backups/ambeauty_${stamp}.dump"
find /backups -name 'ambeauty_*.dump' -mtime +"${KEEP_DAYS:-14}" -delete
echo "backup ok: ambeauty_${stamp}.dump"
