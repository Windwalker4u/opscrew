#!/bin/bash
# The fake pg_dump of the agent's tests (see ../account.ts): prints the fake database, $STUB/db,
# after a PostgreSQL dump's first line. It appends its arguments and PGPASSFILE to $STUB/pg.log
# and, to $STUB/logins, the user it signs in as (-U), which it does as libpq would only when the
# first line of the file PGPASSFILE names starts with the host, port, database and user it is given
# (-h, -p, -d, -U).
echo "pg_dump $* PGPASSFILE=${PGPASSFILE:-}" >> "$STUB/pg.log"
host="" port="" database="" user=""
while [ $# -gt 0 ]; do
  case $1 in
    -h) host=$2; shift ;;
    -p) port=$2; shift ;;
    -d) database=$2; shift ;;
    -U) user=$2; shift ;;
  esac
  shift
done
if [[ $(head -n 1 "${PGPASSFILE:-/dev/null}" 2> /dev/null) != "$host:$port:$database:$user:"* ]]; then
  echo 'pg_dump: error: connection to server failed: fe_sendauth: no password supplied' >&2
  exit 1
fi
echo "pg_dump $user" >> "$STUB/logins"
echo "-- PostgreSQL database dump"
cat "$STUB/db"
