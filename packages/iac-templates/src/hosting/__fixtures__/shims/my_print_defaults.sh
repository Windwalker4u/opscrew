#!/bin/bash
# The fake my_print_defaults of the agent's tests (see ../account.ts): the options the account's
# standard option files give the groups it is asked for, one per line: $STUB/print-defaults when it
# is there, none otherwise. Each run's groups go to $STUB/print-defaults.log.
echo "$*" >> "$STUB/print-defaults.log"
if [ -f "$STUB/print-defaults" ]; then cat "$STUB/print-defaults"; fi
