#!/usr/bin/env bash
# Smith Chart Tutor for macOS: double-click to set up (first time only) and start.
# The first time, macOS may say it can't check this file: right-click it, choose Open, then Open.
exec bash "$(dirname "$0")/scripts/start-unix.sh" "$@"
