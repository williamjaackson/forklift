#!/bin/sh
# Container entrypoint. Everything Forklift and the tools it runs write goes
# under /data, so the rest of the filesystem can be read-only.
set -eu
mkdir -p "$HOME"
exec forklift "$@"
