#!/bin/bash
# The fake mysql of the agent's tests (see ../account.ts): the query for the tables to drop answers
# one; anything read from standard input becomes the fake database ($STUB/db), its state= line,
# after the drop it must start with. A dump whose state= line is the one in $STUB/refuse fails,
# with the database left as it was. It appends to $STUB/logins the user the real client would sign
# in as: --defaults-file=<file> reads that file alone; --defaults-extra-file=<file> reads it, then
# ~/.my.cnf, whose user= wins.
#
# Signed in with the drill database's login (--defaults-file=keys/drill.cnf), it plays the drill
# database, $STUB/drill-db, which holds the CREATE TABLE lines of its tables: the drop query answers
# a DROP for each, the count query their number (or $STUB/drill-count's), and what it reads (each
# input appended to $STUB/drill-input) must start with those drops, then its CREATE TABLE lines
# become the drill database. A DEFINER= in it outside a row fails, as the drill's user may not set
# one; with $STUB/drill-refuse, a load that makes tables fails after the first of them.
echo "mysql $*" >> "$STUB/mysql.log"
case ${1:-} in
  --defaults-file=*) files=("${1#--defaults-file=}") ;;
  --defaults-extra-file=*) files=("${1#--defaults-extra-file=}" "$HOME/.my.cnf") ;;
  *) files=() ;;
esac
user=none
for file in ${files[@]+"${files[@]}"}; do
  found=$(sed -n 's/^user=//p' "$file" 2> /dev/null | tail -n 1)
  if [ -n "$found" ]; then user=$found; fi
done
echo "mysql $user" >> "$STUB/logins"
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
  printf '%s\n' "$input" >> "$STUB/drill-input"
  if [[ $input != "SET FOREIGN_KEY_CHECKS=0;"$'\n'"$drops"* ]]; then
    echo "ERROR: the drill database's tables were not dropped first" >&2
    exit 1
  fi
  if grep -v '^INSERT ' <<< "$input" | grep -q 'DEFINER='; then
    echo "ERROR 1227 (42000) at line 1: Access denied; you need (at least one of) the SUPER or SET_USER_ID privilege(s) for this operation" >&2
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
