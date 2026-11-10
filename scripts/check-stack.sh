#!/bin/sh
# The paste-into-Komodo checks, in one file so CI and a workstation run the same thing:
#
#   scripts/check-stack.sh
#
# Three things break a deploy without any of the page misbehaving, so they are worth a script:
#
#   1. deploy/stack.yml interpolates ${VAR}s, and nginx/default.conf.template has its own. One that
#      the image's ENV block does not define arrives at the container empty -- which for UPSTREAM_URL
#      is a proxy that answers 502, and for PORT a healthcheck that misses a running container.
#   2. scripts/publish.sh --compose must resolve to a pinned image line. That output is what gets
#      pasted into Komodo, and a tag left as "latest" there means whatever was pushed last rather
#      than what you just built.
#   3. The healthcheck has to survive the substitution: Komodo reads it, and a stack without one
#      calls a container that never started healthy.
#
# Needs git, for --compose. The nginx syntax test of the rendered template is CI's job -- it wants
# the image's own nginx and its /etc/nginx/conf.d layout, not whatever is on this machine.
set -eu
cd "$(dirname "$0")/.."

fails=0
ok() { printf 'ok   %s\n' "$1"; }
no() { printf 'FAIL %s\n' "$1"; fails=$((fails + 1)); }

# A CI container's checkout is owned by whoever mounted it, and git calls that "dubious ownership"
# and refuses to name the commit. That is a fact about the runner, not about the stack.
git rev-parse HEAD >/dev/null 2>&1 || git config --global --add safe.directory "$PWD" >/dev/null 2>&1 || true

# Every ${VAR} a file names, one per line.
vars_in() { grep -o '\${[A-Z_][A-Z_0-9]*' "$1" 2>/dev/null | sed 's/^\${//' | sort -u; }

defined_in_dockerfile() {
  # Matches both `ENV PORT=8090 \` and the indented continuation lines under it.
  grep -Eq '^(ENV )?[[:space:]]*'"$1"'=' Dockerfile
}

for v in $(vars_in deploy/stack.yml); do
  [ "$v" = IMAGE ] && continue        # the image tag is compose's business, not the container's
  if defined_in_dockerfile "$v"; then ok "stack's \${$v} has a default in the image"
  else no "stack interpolates \${$v}, which the image never defines -- it would arrive empty"
  fi
done

for v in $(vars_in nginx/default.conf.template); do
  if defined_in_dockerfile "$v"; then ok "template's \${$v} has a default in the image"
  else no "the template uses \${$v} and the image does not define it -- envsubst leaves it empty"
  fi
done

pinned=$(sh scripts/publish.sh --compose)
if printf '%s\n' "$pinned" | grep -Eq '^[[:space:]]*image:[[:space:]]*[^[:space:]]+:[0-9a-f]{7}$'; then
  ok 'publish.sh --compose pins the image to a commit sha'
else
  no "publish.sh --compose produced no pinned image line: $(printf '%s\n' "$pinned" | grep -i image || echo none)"
fi
if printf '%s\n' "$pinned" | grep -q 'image:.*\${'; then
  no 'the pasted stack still has an unsubstituted ${ on the image line'
else
  ok 'the pasted stack has nothing left to substitute on the image line'
fi
if printf '%s\n' "$pinned" | grep -q 'healthcheck:'; then
  ok 'the pasted stack keeps its healthcheck'
else
  no 'the pasted stack lost its healthcheck'
fi
if printf '%s\n' "$pinned" | grep -q 'network_mode: host'; then
  ok 'the pasted stack still shares the host network, which is what makes UPSTREAM_URL correct'
else
  no 'the pasted stack dropped network_mode: host -- 127.0.0.1 would then be the container itself'
fi

[ "$fails" -eq 0 ] || { echo "$fails problem(s) in what Komodo would be given"; exit 1; }
echo 'the stack, the template and the publish path are consistent'
