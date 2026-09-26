#!/usr/bin/env bash
# Validate supabase/migrations on a throwaway postgres:15 container.
# (Kept outside supabase/tests/ on purpose: that folder is reserved for pgTAP via `supabase test db`.)
set -euo pipefail
here="$(cd "$(dirname "$0")" && pwd)"
root="$(cd "$here/.." && pwd)"
name=chartswipe-pg-validate
docker rm -f "$name" >/dev/null 2>&1 || true
docker run -d --name "$name" -e POSTGRES_PASSWORD=postgres postgres:15 >/dev/null
trap 'docker rm -f "$name" >/dev/null 2>&1 || true' EXIT
until docker exec "$name" pg_isready -U postgres >/dev/null 2>&1; do sleep 1; done
sleep 1
run() { docker exec -i "$name" psql -v ON_ERROR_STOP=1 -U postgres -q "$@"; }
run < "$here/stubs.sql"
for f in "$root"/migrations/*.sql; do echo "apply $(basename "$f")"; run < "$f"; done
run < "$root/seed.sql" >/dev/null
run < "$here/checks.sql"
