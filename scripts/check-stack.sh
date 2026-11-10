#!/bin/sh
# The paste-into-Komodo checks, in one file so CI and a workstation run the same thing:
#
#   scripts/check-stack.sh
#
# Three things break a deploy without any of the page misbehaving, so they are worth a script:
#
#   1. deploy/stack.yml interpolates ${VAR}s, and nginx/default.conf.template has its own. One that
#      the image's ENV block does not define arrives at the container empty -- which for UPSTREAM_URL
#      is a proxy that answers 502, and for PORT a healthcheck that misses a running container. The
#      other direction matters too: a variable the image defines that the stack never names is a
#      setting with no way to set it from Komodo.
#   2. scripts/publish.sh --compose must resolve to a pinned image line. That output is what gets
#      pasted into Komodo, and a tag left as "latest" there means whatever was pushed last rather
#      than what you just built.
#   3. The healthcheck has to survive the substitution: Komodo reads it, and a stack without one
#      calls a container that never started healthy.
#   4. The page reads fields out of /config.json. If the template stops returning one, the setting
#      silently falls back instead of failing, so the pair is checked together.
#   5. The README shows a compose to copy. It is checked against the image too, because a README that
#      advertises a setting nobody implemented is worse than one that says nothing.
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

# The other direction. VERSION is the build's own (it comes from the commit), so the stack has no
# business setting it; everything else the image defines should be nameable in the stack you paste.
for v in $(sh scripts/template-vars.sh | tr ' ' '\n' | tr -d '$'); do
  [ "$v" = VERSION ] && continue
  # Fixed-string, because "does the stack name ${VAR" is the whole question: what follows -- `:-` a
  # default, or nothing at all -- is compose's business. A bracket expression asking the same thing
  # reads differently to busybox grep than to GNU's, which is how this check once failed only in CI.
  if grep -qF "\${$v" deploy/stack.yml; then ok "$v can be set from the stack"
  else no "$v is defined by the image but deploy/stack.yml never names it -- no way to set it in Komodo"
  fi
done

# /config.json is the only way the container's settings reach the page; each field the page reads is
# checked here rather than relying on the page's fallback, which fails silently.
for field in model title stream maxDuration defaultDuration requestTimeout upstream upstreamOptions version; do
  if grep -q "\\\"$field\\\":" nginx/default.conf.template; then ok "/config.json carries $field"
  else no "/config.json does not carry $field, which the page asks for"
  fi
done

# The X-Upstream allow-list is generated at start, so the image has to carry the generator and run it
# -- /docker-entrypoint.d only executes files that are executable.
if [ -f docker/10-upstream-map.sh ] && sh -n docker/10-upstream-map.sh \
   && grep -q 'COPY docker/10-upstream-map.sh /docker-entrypoint.d/' Dockerfile \
   && grep -q 'chmod +x /docker-entrypoint.d/10-upstream-map.sh' Dockerfile; then
  ok 'the X-Upstream allow-list is generated at container start, and the image makes it runnable'
else
  no 'docker/10-upstream-map.sh is missing, unparsable, or not copied-and-chmodded by the Dockerfile'
fi

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

# The compose in the README is the one people copy, so it is held to the same standard as
# deploy/stack.yml: the settings the image actually defines, the port its own healthcheck names, an
# image line pointing at the registry scripts/publish.sh pushes to, and a tag that is a commit of
# this repository rather than one typed from memory.
readme=$(awk '/^```yaml$/{buf="";inb=1;next} /^```$/{if (inb && buf ~ /services:/) printf "%s", buf; inb=0; next} inb{buf=buf $0 "\n"}' README.md)
if [ -z "$readme" ]; then
  no 'README.md has no compose block to check'
else
  want=$(sh scripts/template-vars.sh | tr ' ' '\n' | tr -d '$' | grep -vx VERSION | sort -u)
  have=$(printf '%s\n' "$readme" | sed -n 's/^      \([A-Z_][A-Z_0-9]*\):.*/\1/p' | sort -u)
  if [ "$want" = "$have" ]; then
    ok "the README's compose offers the $(printf '%s\n' "$have" | wc -l | tr -d ' ') settings the image defines, and no others"
  else
    no "the README's compose and the image disagree -- image: [$(printf '%s\n' "$want" | tr '\n' ' ')] README: [$(printf '%s\n' "$have" | tr '\n' ' ')]"
  fi

  rport=$(printf '%s\n' "$readme" | sed -n 's/^      PORT: "\([0-9]*\)".*/\1/p')
  if [ -n "$rport" ] && printf '%s\n' "$readme" | grep -qF "http://127.0.0.1:$rport/healthz"; then
    ok "its healthcheck names the port it sets ($rport)"
  else
    no "the README's healthcheck does not name its own PORT (${rport:-unset}) -- a changed port would leave it probing nothing"
  fi

  # Where the image comes from is taken from publish.sh itself rather than from the stack it just
  # printed, because that output is a tag only when there is a commit to name -- in a directory with
  # no git history it says `:dev`, and the tail of that is what used to end up in `repo`.
  repo=$(sed -n 's#^IMAGE=\${IMAGE:-\(.*\)}#\1#p' scripts/publish.sh | head -1)
  if [ -n "$repo" ] && printf '%s\n' "$readme" | grep -q "image: $repo:"; then
    ok "it pulls from the registry publish.sh pushes to ($repo)"
  else
    no "the README's compose is not pulling ${repo:-the registry publish.sh pushes to}"
  fi

  rsha=$(printf '%s\n' "$readme" | sed -n 's#.*radiance-studio:\([0-9a-f]\{7,40\}\).*#\1#p' | head -1)
  if ! git rev-parse HEAD >/dev/null 2>&1; then
    ok "its tag ($rsha) not checked here: no git history in this checkout"
  elif git rev-parse --is-shallow-repository 2>/dev/null | grep -q true; then
    ok "its tag ($rsha) not checked here: the checkout is shallow"
  elif [ -n "$rsha" ] && git cat-file -e "$rsha^{commit}" 2>/dev/null; then
    ok "its tag ($rsha) is a commit of this repository"
  else
    no "the README's example tags ${rsha:-nothing}, which is not a commit of this repository"
  fi
fi

[ "$fails" -eq 0 ] || { echo "$fails problem(s) in what Komodo would be given"; exit 1; }
echo 'the stack, the template, the README and the publish path are consistent'