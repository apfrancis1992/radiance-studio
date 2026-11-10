#!/bin/sh
# The names the container substitutes, in the form envsubst wants them: `$PORT $UPSTREAM_URL ...`.
#
# Both the config-template check in CI and scripts/check-stack.sh need this list, and reading it out
# of the Dockerfile's ENV block is the only way it cannot drift from what the image actually defines.
# A bare `envsubst` would substitute nginx's own variables too -- $upstream, $request_uri -- which is
# how a template that renders can still be wrong, so the list is always passed explicitly.
set -eu
cd "$(dirname "$0")/.."

sed -n '/^ENV /,/[^\\]$/p' Dockerfile \
  | tr -d '\\' \
  | sed 's/^ENV //' \
  | tr ' ' '\n' \
  | sed -n 's/^\([A-Z_][A-Z_0-9]*\)=.*/\1/p' \
  | sed 's/^/$/' \
  | tr '\n' ' ' \
  | sed 's/ $//'
