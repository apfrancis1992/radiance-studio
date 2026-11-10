#!/bin/sh
# Publish the image to GitHub's container registry, and print the compose to paste into Komodo.
#
#   scripts/publish.sh              build, push ghcr.io/<owner>/radiance-studio:<sha> and :latest
#   scripts/publish.sh --compose    print deploy/stack.yml with the image pinned to this commit; push nothing
#   scripts/publish.sh --check      only report whether the image is anonymously pullable
#   scripts/publish.sh --sha-only   skip :latest (the pinned stack does not need it)
#   scripts/publish.sh --no-wait    do not sit and re-probe while you make the package public
#   IMAGE=ghcr.io/you/other-name scripts/publish.sh
#
# One credential is needed: a GitHub token that can write packages. The `gh` CLI's own token works
# once it has the scope --
#
#   gh auth refresh --hostname github.com -s write:packages      # gh >= 2.9x
#   gh auth refresh-token -s write:packages                      # gh < 2.9x, same thing
#
# (a browser click; the scopes gh already has are kept) -- or set GH_TOKEN to a PAT with
# write:packages, plus GH_USERNAME. The credential is piped to `docker login`, never written to a
# file, so ~/.docker/config.json keeps no long-lived secret unless docker stores one itself.
#
# The first push creates the package **private**, and ghcr has no API to change that: the packages
# endpoints answer 404 for container packages, whatever token asks. So nothing here guesses at
# visibility -- the script asks the registry the question that matters, anonymously: token exchange,
# then the manifest, which is exactly what a credential-less GPU host does. If the answer is no, it
# prints the one web-UI click and re-probes for two minutes while you make it, then says so.
set -eu
cd "$(dirname "$0")/.."

IMAGE=${IMAGE:-ghcr.io/apfrancis1992/radiance-studio}
registry=${IMAGE%%/*}                       # ghcr.io
path=${IMAGE#"$registry"/}                  # owner/radiance-studio
package=${path##*/}                         # radiance-studio, the name the package settings page uses
wait=yes
wait_seconds=${WAIT_SECONDS:-120}
mode=push

sha=$(git rev-parse --short=7 HEAD 2>/dev/null || echo dev)
[ "$sha" = dev ] && echo "publish.sh: not a git checkout, tagging :dev" >&2
dirty=$(git status --porcelain 2>/dev/null || true)

case "${1:-}" in
  --compose)
    # The whole stack, image line resolved, ready for Komodo's editor. Everything else keeps its
    # ${VAR:-default} form, which is how the stack's own environment reaches it.
    sed "s|^\([[:space:]]*image:\).*|\1 ${IMAGE}:${sha}|" deploy/stack.yml
    exit 0 ;;
  --check)     mode=check ;;
  --sha-only)  latest= ;;
  --no-wait)   latest=yes; wait=no ;;
  --help|-h)   awk 'NR==1{next} /^#/{sub(/^# ?/,""); print; next} {exit}' "$0"; exit 0 ;;
  "")          latest=yes ;;
  *) echo "publish.sh: unknown option '$1' (--compose, --check, --sha-only, --no-wait)" >&2; exit 2 ;;
esac

# The pull probe, from a process with no credentials of its own. 0 means a host that has never
# heard of this repository can `docker pull` it, which is the property a Komodo deploy depends on.
pullable() {
  t=$(curl -fsS -o - "https://$registry/token?scope=repository:$path:pull" 2>/dev/null \
        | sed -n 's/.*"token":"\([^"]*\)".*/\1/p')
  [ -n "$t" ] || return 1
  curl -fsS -o /dev/null -H "Authorization: Bearer $t" \
    -H "Accept: application/vnd.oci.image.index.v1+json, application/vnd.docker.distribution.manifest.v2+json, application/vnd.oci.image.manifest.v1+json" \
    "https://$registry/v2/$path/manifests/$sha" 2>/dev/null
}

if [ "$mode" = check ]; then
  if pullable; then echo "$IMAGE:$sha is anonymously pullable."; else
    echo "$IMAGE:$sha is not anonymously pullable (private, or not pushed)."
    exit 1
  fi
  exit 0
fi

[ -z "$dirty" ] || echo "publish.sh: the tree has uncommitted changes, and the image is built from the tree, not from $sha" >&2

# ── login ───────────────────────────────────────────────────────────────────────────────────────
pat=${GH_TOKEN:-}
[ -n "$pat" ] || pat=${GITHUB_TOKEN:-}
if [ -n "$pat" ]; then
  user=${GH_USERNAME:-}
  [ -n "$user" ] || { echo "publish.sh: with GH_TOKEN set, also set GH_USERNAME (the ghcr.io owner)" >&2; exit 2; }
else
  command -v gh >/dev/null || { echo "publish.sh: no GH_TOKEN and no gh on PATH" >&2; exit 2; }
  user=$(gh api user -q .login)
  pat=$(gh auth token)
fi
printf '%s' "$pat" | docker login "$registry" -u "$user" --password-stdin >/dev/null
echo "logged in to $registry as $user"

# ── build and push ──────────────────────────────────────────────────────────────────────────────
head=$(git rev-parse HEAD 2>/dev/null || echo '')
set -- build --build-arg GIT_SHA="$head" -t "$IMAGE:$sha"
[ -n "${latest:-}" ] && set -- "$@" -t "$IMAGE:latest"
docker "$@" .
# The pinned tag first: if :latest fails, the commit you are deploying is already in the registry.
docker push "$IMAGE:$sha"
[ -n "${latest:-}" ] && docker push "$IMAGE:latest"

# ── is it pullable? ─────────────────────────────────────────────────────────────────────────────
if pullable; then
  echo "public: docker pull $IMAGE:$sha needs no login."
else
  echo "The package is private -- ghcr creates it that way, and there is no API for the switch"
  echo "(the packages endpoints 404 for container packages). One click, in the web UI:"
  echo "  https://github.com/users/$user/packages/container/$package/settings"
  echo "  Change visibility -> Public -> confirm."
  if [ "$wait" = yes ]; then
    printf 're-probing for %ss: ' "$wait_seconds"
    left=$wait_seconds
    while [ "$left" -gt 0 ]; do
      if pullable; then echo " public."; break; fi
      printf .; sleep 5; left=$((left - 5))
    done
    [ "$left" -gt 0 ] || {
      echo
      echo "still private: a host with no credentials cannot pull it, so the Komodo deploy will fail"
      echo "on the pull. Either make it public, or give that host a login: docker login ghcr.io"
    }
  fi
fi

echo
echo "Komodo: paste this (deploy/stack.yml with the image pinned to $sha) --"
sed "s|^\([[:space:]]*image:\).*|\1 ${IMAGE}:${sha}|" deploy/stack.yml | sed 's/^/  /'
