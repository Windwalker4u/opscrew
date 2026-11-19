#!/bin/bash
# The fake psql of the agent's tests (see ../account.ts), PostgreSQL's mysql.sh. It appends its
# arguments and PGPASSFILE to $STUB/pg.log and, to $STUB/logins, the user it signs in as (-U), which
# it does as libpq would only when the first line of the file PGPASSFILE names starts with the
# host, port, database and user it is given (-h, -p, -d, -U). A load (no -c) without
# -v ON_ERROR_STOP=1 fails, as one that goes on past an error would restore part of a dump.
#
# Signed in with the drill database's login (PGPASSFILE=keys/drill.pgpass), it plays the drill
# database, $STUB/drill-db, which holds the CREATE TABLE lines of its tables: the drop query (-c)
# answers a DROP for each, the count query their number (or $STUB/drill-count's), and what it reads
# (each input appended to $STUB/drill-input) must start with those drops, then its CREATE TABLE
# lines become the drill database; with $STUB/drill-refuse, a load that makes tables fails after
# the first of them. Otherwise it plays the app's database: the drop query answers one table, what
# it reads must start with that drop, and its state= line becomes the fake database ($STUB/db); a
# dump whose state= line is the one in $STUB/refuse fails, with the database left as it was.
echo "psql $* PGPASSFILE=${PGPASSFILE:-}" >> "$STUB/pg.log"
host="" port="" database="" user="" query="" stop=no
while [ $# -gt 0 ]; do
  case $1 in
    -h) host=$2; shift ;;
    -p) port=$2; shift ;;
    -d) database=$2; shift ;;
    -U) user=$2; shift ;;
    -c) query=$2; shift ;;
    -v) if [ "$2" = ON_ERROR_STOP=1 ]; then stop=yes; fi; shift ;;
  esac
  shift
done
if [[ $(head -n 1 "${PGPASSFILE:-/dev/null}" 2> /dev/null) != "$host:$port:$database:$user:"* ]]; then
  echo 'psql: error: connection to server failed: fe_sendauth: no password supplied' >&2
  exit 2
fi
echo "psql $user" >> "$STUB/logins"
if [ -z "$query" ] && [ "$stop" != yes ]; then
  echo "ERROR: the load doesn't stop at its first error" >&2
  exit 1
fi
first='SET client_min_messages = warning;'
if [ "${PGPASSFILE:-}" = keys/drill.pgpass ]; then
  db=$STUB/drill-db
  drops=$(sed -n 's/^CREATE TABLE \([^ ]*\) .*/DROP TABLE IF EXISTS \1 CASCADE;/p' "$db" 2> /dev/null)
  if [ -n "$query" ]; then
    if [[ $query == *"count(*)"* ]] && [ -f "$STUB/drill-count" ]; then
      cat "$STUB/drill-count"
    elif [[ $query == *"count(*)"* ]]; then
      grep -c '^CREATE TABLE ' "$db" 2> /dev/null || true
    elif [ -n "$drops" ]; then
      printf '%s\n' "$drops"
    fi
    exit 0
  fi
  input=$(cat)
  printf '%s\n' "$input" >> "$STUB/drill-input"
  if [[ $input != "$first"$'\n'"$drops"* ]]; then
    echo "ERROR: the drill database's tables were not dropped first" >&2
    exit 3
  fi
  if [ -f "$STUB/drill-refuse" ] && grep -q '^CREATE TABLE ' <<< "$input"; then
    grep -m 1 '^CREATE TABLE ' <<< "$input" > "$db"
    echo 'ERROR:  syntax error at or near "CREATE"' >&2
    exit 3
  fi
  grep '^CREATE TABLE ' <<< "$input" > "$db" || true
  exit 0
fi
if [ -n "$query" ]; then
  echo 'DROP TABLE IF EXISTS public.notes CASCADE;'
  exit 0
fi
input=$(cat)
if [[ $input != "$first"$'\n''DROP TABLE IF EXISTS public.notes CASCADE;'* ]]; then
  echo "ERROR: the tables were not dropped first" >&2
  exit 3
fi
state=$(grep '^state=' <<< "$input")
if [ -f "$STUB/refuse" ] && [ "$state" = "$(cat "$STUB/refuse")" ]; then
  echo 'ERROR:  syntax error at or near "state"' >&2
  exit 3
fi
echo "$state" > "$STUB/db"
