#!/bin/bash
# The fake mysql of the agent's tests (see ../account.ts): the query for the tables to drop answers
# one; anything read from standard input becomes the fake database ($STUB/db), its state= line,
# after the drop it must start with. A dump whose state= line is the one in $STUB/refuse fails,
# with the database left as it was.
#
# Signed in with the drill database's login (--defaults-file=keys/drill.cnf), it plays the drill
# database, $STUB/drill-db, which holds the CREATE TABLE lines of its tables: the drop query answers
# a DROP for each, the count query their number (or $STUB/drill-count's), and what it reads must
# start with those drops, then its CREATE TABLE lines become the drill database. With
# $STUB/drill-refuse, a load that makes tables fails after the first of them.
echo "mysql $*" >> "$STUB/mysql.log"
if [ "${1:-}" = --defaults-file=keys/drill.cnf ]; then
  db=$STUB/drill-db
  drops=$(sed -n 's/^CREATE TABLE `\([^`]*\)`.*/DROP TABLE IF EXISTS `\1`;/p' "$db" 2> /dev/null)
  if [[ " $* " == *" -e "* ]]; then
    if [[ $* == *"COUNT(*)"* ]] && [ -f "$STUB/drill-count" ]; then
      cat "$STUB/drill-count"
    elif [[ $* == *"COUNT(*)"* ]]; then
      grep -c '^CREATE TABLE ' "$db" 2> /dev/null || true
    elif [ -n "$drops" ]; then
      printf '%s\n' "$drops"
    fi
    exit 0
  fi
  input=$(cat)
  if [[ $input != "SET FOREIGN_KEY_CHECKS=0;"$'\n'"$drops"* ]]; then
    echo "ERROR: the drill database's tables were not dropped first" >&2
    exit 1
  fi
  if [ -f "$STUB/drill-refuse" ] && grep -q '^CREATE TABLE ' <<< "$input"; then
    grep -m 1 '^CREATE TABLE ' <<< "$input" > "$db"
    echo "ERROR 1064 (42000): You have an error in your SQL syntax" >&2
    exit 1
  fi
  grep '^CREATE TABLE ' <<< "$input" > "$db" || true
  exit 0
fi
if [[ " $* " == *" -e "* ]]; then
  echo 'DROP TABLE IF EXISTS `notes`;'
  exit 0
fi
input=$(cat)
if [[ $input != "SET FOREIGN_KEY_CHECKS=0;"$'\n''DROP TABLE IF EXISTS `notes`;'* ]]; then
  echo "ERROR: the tables were not dropped first" >&2
  exit 1
fi
state=$(grep '^state=' <<< "$input")
if [ -f "$STUB/refuse" ] && [ "$state" = "$(cat "$STUB/refuse")" ]; then
  echo "ERROR 1064 (42000): You have an error in your SQL syntax" >&2
  exit 1
fi
echo "$state" > "$STUB/db"
