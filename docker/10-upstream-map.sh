#!/bin/sh
# Write the `map` that lets one request choose which llama-swap to talk to.
#
# A request may carry `X-Upstream: http://host:port` and every proxied route then goes there for
# that one request -- which is how one deployed page reaches a second llama-swap. A browser sends
# whatever headers it likes, so the choice is honoured only for a URL the deployment listed in
# UPSTREAM_OPTIONS; that JSON array is both the allow-list and what /config.json hands the page to
# put in its dropdown. Empty (the default) means the header is ignored: no caller can turn this
# container into an open proxy, and no key of ours rides along to a host the operator never named.
#
# The stock nginx entrypoint runs this from /docker-entrypoint.d, before it renders the config
# templates. It writes a map into the conf.d directory, which nginx reads in its http context. Set
# CONF_DIR to write somewhere else, which is how CI checks the output without a container.
set -eu

CONF_DIR=${CONF_DIR:-/etc/nginx/conf.d}
options=${UPSTREAM_OPTIONS:-}
out="$CONF_DIR/10-upstream-map.conf"

# The urls, out of the JSON in the order they were written. Key order in the objects does not
# matter; `"url": "..."` does, since a shell script is not a JSON parser -- a typo here means the
# option is missing from the list, which is visible, rather than something silently allowed.
urls=$(printf '%s' "$options" | grep -o '"url"[[:space:]]*:[[:space:]]*"[^"]*"' \
        | sed 's/.*:[[:space:]]*"\(.*\)"$/\1/')

pattern=''
for url in $urls; do
  case "$url" in
    http://* | https://*) ;;
    *) echo "10-upstream-map.sh: ignoring '$url': needs an http:// or https:// scheme" >&2; continue ;;
  esac
  rest=${url#*://}
  case "$rest" in
    '') echo "10-upstream-map.sh: ignoring '$url': no host after the scheme" >&2; continue ;;
    */*) echo "10-upstream-map.sh: ignoring '$url': a target is scheme://host[:port] with no path" >&2; continue ;;
  esac
  case "$rest" in
    *[!A-Za-z0-9.:-]*) echo "10-upstream-map.sh: ignoring '$url': hostnames and a port only" >&2; continue ;;
  esac
  # Quote for PCRE. Everything that is not a letter, a digit, `:`, `/` or `-` gets a backslash, so a
  # dot in 127.0.0.1 cannot match 127x0x0x1 and a `+` in a host cannot mean "one or more".
  escaped=$(printf '%s' "$url" | sed 's/\([^A-Za-z0-9:\/-]\)/\\&/g')
  pattern="${pattern:+$pattern|}$escaped"
done

{
  echo '# generated at container start by docker/10-upstream-map.sh, from UPSTREAM_OPTIONS'
  echo '# $upstream_from_header is the X-Upstream header when it names an allowed target, else empty.'
  echo 'map $http_x_upstream $upstream_from_header {'
  echo '    default "";'
  [ -n "$pattern" ] && printf '    "~^(?:%s)$" $http_x_upstream;\n' "$pattern"
  echo '}'
} > "$out"

if [ -n "$pattern" ]; then
  echo "10-upstream-map.sh: X-Upstream is honoured for: $(printf '%s' "$pattern" | tr '|' ' ')"
else
  echo "10-upstream-map.sh: X-Upstream does nothing (UPSTREAM_OPTIONS is empty, or held nothing valid)"
fi
