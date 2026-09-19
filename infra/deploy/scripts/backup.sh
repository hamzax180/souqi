#!/usr/bin/env bash
# =================================================================
#  backup.sh — dump both Postgres clusters
#  -----------------------------------------------------------------
#  Runs ON the server, from the stack directory.
#
#    bash scripts/backup.sh                 # one dump, prune old ones
#    bash scripts/backup.sh --install-cron  # nightly at 03:15
#    bash scripts/backup.sh --list
#    bash scripts/backup.sh --restore /opt/platform/backups/x.sql.gz
#    bash scripts/backup.sh --restore-userdb /opt/platform/backups/souqi_userdb-x.sql.gz
#
#  Two dumps, because there are two Postgres clusters and they hold very
#  different things:
#
#    ${PG_DB}-*        the PLATFORM database — projects, deployments, env
#                      vars, domains, logs. The rows that say which app
#                      belongs to whom and how it runs.
#    souqi_userdb-*    the CUSTOMER data cluster — one database per project,
#                      plus the roles that own them. This is the one that
#                      holds work nobody can rebuild.
#
#    NOT covered       the images themselves. They rebuild from source.
#
#  Restoring the platform dump and re-running deploys rebuilds every app,
#  and restoring the customer dump puts their data back under it.
#
#  SOURCE ARCHIVES ARE IN HERE NOW, and that is a deliberate change of
#  category, not an accident. They used to live only in object storage —
#  and with no bucket configured, only on the VM, which is the thing the
#  spec forbids. With S3 unset they go into the platform Postgres instead
#  (source_archives, see src/storage/objects.js), so this dump covers
#  them. The cost: it is bigger, and it now contains every customer's
#  application source. Treat where this file is written and who can read
#  it as a decision in its own right, not as a property of a backup.
#  This is still not a full disaster plan: see --install-cron.
# =================================================================
set -euo pipefail

HERE="$(cd "$(dirname "${BASH_SOURCE[0]}")/.." && pwd)"
cd "$HERE"

BACKUP_DIR="${BACKUP_DIR:-/opt/platform/backups}"
KEEP_DAYS="${BACKUP_KEEP_DAYS:-14}"

# Read from .env rather than taking them as arguments: a password passed on
# a command line is visible in ps output to every process on the box.
env_get() { grep -E "^$1=" .env 2>/dev/null | head -1 | cut -d= -f2- || true; }
PG_USER="$(env_get POSTGRES_USER)"; PG_USER="${PG_USER:-souqi}"
PG_DB="$(env_get POSTGRES_DB)";     PG_DB="${PG_DB:-souqi_deploy}"
USERDB_USER="$(env_get USERDB_SUPERUSER)"; USERDB_USER="${USERDB_USER:-souqiadmin}"
USERDB_NAME="souqi_userdb"

say()  { printf "\n\033[1m%s\033[0m\n" "$*"; }
fail() { printf "\n\033[31m%s\033[0m\n\n" "$*"; exit 1; }

compose() { docker compose "$@"; }

do_backup() {
  mkdir -p "$BACKUP_DIR"
  chmod 700 "$BACKUP_DIR"

  compose ps --status running --quiet postgres | grep -q . \
    || fail "postgres is not running. Start the stack first: docker compose up -d"

  local stamp file tmp
  stamp="$(date -u +%Y%m%d-%H%M%S)"
  file="${BACKUP_DIR}/${PG_DB}-${stamp}.sql.gz"
  tmp="${file}.partial"

  say "Dumping ${PG_DB}"
  # -T disables the TTY so this works from cron. The password comes from the
  # container environment, so it is never on this command line.
  if ! compose exec -T postgres pg_dump -U "$PG_USER" -d "$PG_DB" --clean --if-exists \
       | gzip -9 > "$tmp"; then
    rm -f "$tmp"
    fail "pg_dump failed — nothing written"
  fi

  # A truncated dump that looks like a backup is worse than no backup, so
  # verify the gzip stream and the tail marker before adopting the name.
  gzip -t "$tmp" 2>/dev/null || { rm -f "$tmp"; fail "dump is not valid gzip — discarded"; }
  gzip -dc "$tmp" | tail -5 | grep -q "PostgreSQL database dump complete" \
    || { rm -f "$tmp"; fail "dump is truncated — discarded"; }

  mv "$tmp" "$file"
  chmod 600 "$file"
  echo "  $(du -h "$file" | cut -f1)  $file"

  do_userdb_backup "$stamp"

  say "Pruning dumps older than ${KEEP_DAYS} days"
  local pruned
  # Both families. Retention that only knew about ${PG_DB}-* would keep
  # every customer dump for ever and quietly fill the disk this all runs on.
  pruned="$( { find "$BACKUP_DIR" -name "${PG_DB}-*.sql.gz"     -mtime "+${KEEP_DAYS}" -print -delete;
             find "$BACKUP_DIR" -name "${USERDB_NAME}-*.sql.gz" -mtime "+${KEEP_DAYS}" -print -delete; } | wc -l)"
  echo "  removed ${pruned}"
}

# The customer data cluster. A separate dump because it is a separate
# Postgres: souqi-userdb holds one database per project and is the only
# thing here that stores work the customer made rather than metadata we
# can rebuild. Losing the platform database costs a redeploy; losing this
# one costs their data.
#
# pg_dumpall, not pg_dump. Every project's database has to be in one file
# AND so do the ROLES that own them — a per-database dump restores tables
# owned by roles that no longer exist, and every GRANT in it fails. The
# roles are the isolation, so a restore without them is a restore without
# the thing this cluster is for.
do_userdb_backup() {
  local stamp file tmp
  stamp="$1"

  compose ps --status running --quiet userdb | grep -q . || {
    printf "  userdb is not running — skipped\n"
    return 0
  }

  file="${BACKUP_DIR}/${USERDB_NAME}-${stamp}.sql.gz"
  tmp="${file}.partial"

  say "Dumping customer databases"
  # Same rule as above: -T for cron, and the password stays in the
  # container's environment rather than on this command line.
  if ! compose exec -T userdb pg_dumpall -U "$USERDB_USER" --clean \
       | gzip -9 > "$tmp"; then
    rm -f "$tmp"
    fail "pg_dumpall failed — nothing written for the customer cluster"
  fi

  gzip -t "$tmp" 2>/dev/null || { rm -f "$tmp"; fail "customer dump is not valid gzip — discarded"; }
  # "CLUSTER dump complete" — pg_dumpall's own marker, which is not the one
  # pg_dump writes. Reusing the pg_dump wording here discarded every good
  # dump as truncated, so the check has to know which tool produced the file.
  gzip -dc "$tmp" | tail -5 | grep -q "PostgreSQL database cluster dump complete" \
    || { rm -f "$tmp"; fail "customer dump is truncated — discarded"; }

  mv "$tmp" "$file"
  chmod 600 "$file"
  echo "  $(du -h "$file" | cut -f1)  $file"
}


do_list() {
  say "Backups in ${BACKUP_DIR}"
  [ -d "$BACKUP_DIR" ] || { echo "  none"; return; }
  ls -lh "$BACKUP_DIR"/*.sql.gz 2>/dev/null | awk '{print "  " $5 "  " $6 " " $7 " " $8 "  " $9}' \
    || echo "  none"
}

do_restore() {
  local src="${1:-}"
  [ -f "$src" ] || fail "no such backup: $src"
  gzip -t "$src" 2>/dev/null || fail "$src is not a valid gzip file"

  # Restoring overwrites live data, so it asks even though nothing else here
  # is interactive. Cron never reaches this path.
  printf "\n\033[31mThis REPLACES the current contents of %s.\033[0m\n" "$PG_DB"
  printf "Running deployments keep running; their rows are overwritten.\n\n"
  read -r -p "Type the database name to confirm: " answer
  [ "$answer" = "$PG_DB" ] || fail "cancelled"

  say "Restoring ${src}"
  gzip -dc "$src" | compose exec -T postgres psql -U "$PG_USER" -d "$PG_DB" -v ON_ERROR_STOP=1 \
    || fail "restore failed — the database may be half-written; restore again from a known-good dump"

  say "Restarting api and worker"
  compose restart api worker
  echo "  done"
}

# The customer cluster. Separate from do_restore because it is a separate
# server with its own superuser, and because pg_dumpall output is fed to
# psql against `postgres` rather than one named database — the script
# creates the roles and databases as it goes.
do_restore_userdb() {
  local src="${1:-}"
  [ -f "$src" ] || fail "no such backup: $src"
  gzip -t "$src" 2>/dev/null || fail "$src is not a valid gzip file"

  compose ps --status running --quiet userdb | grep -q . \
    || fail "userdb is not running. Start the stack first: docker compose up -d"

  printf "
[31mThis REPLACES every customer database on this host.[0m
" 
  printf "Running apps hold open connections to these; restart them afterwards.

"
  read -r -p "Type RESTORE to confirm: " answer
  [ "$answer" = "RESTORE" ] || fail "cancelled"

  say "Restoring ${src} into the customer cluster"
  gzip -dc "$src" | compose exec -T userdb psql -U "$USERDB_USER" -d postgres -v ON_ERROR_STOP=1 \
    || fail "restore failed — the cluster may be half-written; restore again from a known-good dump"
  echo "  done"
}

install_cron() {
  # THE LOG GOES SOMEWHERE THIS USER CAN WRITE.
  #
  # This line used to redirect to /var/log/souqi-backup.log. /var/log is
  # root:syslog drwxrwxr-x and the job runs as the deploy user, so the
  # SHELL failed the redirect before backup.sh was ever executed. The
  # cron was installed, cron was running, the script was present and
  # executable, and no backup ran for fifteen days — silently, because
  # the thing that failed was the logging.
  #
  # Found by noticing the newest dump in $BACKUP_DIR was two weeks old on
  # a box whose crontab looked correct. Nothing else would have said so.
  #
  # $BACKUP_DIR is created and chmod 700'd by this script and owned by
  # the user the job runs as, which makes it the one directory here that
  # is guaranteed writable at 03:15.
  local logfile="${BACKUP_DIR}/backup.log"
  local job="15 3 * * * cd ${HERE} && mkdir -p ${BACKUP_DIR} && /usr/bin/env bash scripts/backup.sh >> ${logfile} 2>&1"
  # Idempotent: strip any previous line for this script before adding.
  #
  # `|| true` is load-bearing, not defensive noise. grep exits 1 when it
  # prints no lines, and on a host with no crontab at all it prints none —
  # so under `set -e` + `pipefail` the subshell died before `echo "$job"`
  # ever ran, fed an empty stdin to `crontab -`, and installed nothing
  # while reporting failure. It only worked on a box that already had a
  # crontab holding one unrelated line — never the fresh server this is for.
  ( { crontab -l 2>/dev/null || true; } | grep -v "scripts/backup.sh" || true ; echo "$job" ) | crontab -
  say "Installed"
  echo "  15 3 * * *  ->  ${BACKUP_DIR}"
  echo "  log: ${logfile}"
  echo ""
  echo "  Dumps live on the same disk as the database. That covers a bad"
  echo "  migration or a dropped table, not a lost VM. Copy them off the box"
  echo "  as well once there is anything in here worth keeping."
}

case "${1:-}" in
  --install-cron) install_cron ;;
  --list)         do_list ;;
  --restore)      do_restore "${2:-}" ;;
  --restore-userdb) do_restore_userdb "${2:-}" ;;
  "")             do_backup ;;
  *)              fail "unknown option: $1" ;;
esac
