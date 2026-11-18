#!/bin/bash
# The fake mysqldump of the agent's tests (see ../account.ts): prints the fake database, $STUB/db.
# It appends to $STUB/logins the user the real client would sign in as: --defaults-file=<file>
# reads that file alone; --defaults-extra-file=<file> reads it, then ~/.my.cnf, whose user= wins.
echo "mysqldump $*" >> "$STUB/mysql.log"
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
echo "mysqldump $user" >> "$STUB/logins"
echo "-- MariaDB dump 10.19"
cat "$STUB/db"
