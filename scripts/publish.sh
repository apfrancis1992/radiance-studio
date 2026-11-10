#!/bin/sh
# Publish the image to GitHub's container registry, and print the compose line to paste into Komodo.
#
#   scripts/publish.sh              build, push ghcr.io/<owner>/radiance-studio:<sha> and :latest
#   scripts/publish.sh --compose    print deploy/stack.yml with the image pinned to this commit; push nothing
#   scripts/publish.sh --sha-only   skip :latest (the pinned stack does not need it)
#   IMAGE=ghcr.io/you/other-name scripts/publish.sh
#
# One credential is needed: a GitHub token that can write packages. The `gh` CLI's own token works
# once it has the scope --
#
#   gh auth refresh-token -s write:packages
#
# -- or set GH_TOKEN to a PAT (classic: write:packages; fine-grained: Packages write). The token is
# piped to `docker login`, never written to a file, so ~/.docker/config.json keeps no long-lived
# secret unless docker decides to store it itself.
#
# The first push creates the package *private*, and ghcr has no way to make it public at push time:
# the script flips it with the packages API afterwards and, if the token cannot, prints where the
# switch is. Anonymous pullability is checked at the end the same way a naked `docker pull` on the
# GPU host would, so "public" is not a guess.
set -eu
cd "$(dirname "$0")/.."

IMAGE=${IMAGE:-ghcr.io/apfrancis1992/radiance-studio}
registry=${IMAGE%%/*}                       # ghcr.io
path=${IMAGE#"$registry"/}                  # owner/radiance-studio
package=${path##*/}                         # radiance-studio, which is what the packages API calls it

sha=$(git rev-parse --short=7 HEAD 2>/dev/null || echo dev)
[ "$sha" = dev ] && echo "publish.sh: not a git checkout, tagging :dev" >&2
dirty=$(git status --porcelain 2>/dev/null || true)

case "${1:-}" in
  --compose)
    # The whole stack, image line resolved, ready for Komodo's editor. Everything else keeps its
    # ${VAR:-default} form, which is how the stack's own environment reaches it.
    sed "s|^\([[:space:]]*image:\).*|\1 ${IMAGE}:${sha}|" deploy/stack.yml
    exit 0 ;;
  --sha-only) latest= ;;
  --help|-h)  awk 'NR==1{next} /^#/{sub(/^# ?/,""); print; next} {exit}' "$0"; exit 0 ;;
  "") latest=yes ;;
  *) echo "publish.sh: unknown option '$1' (--compose, --sha-only)" >&2; exit 2 ;;
esac

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

# ── visibility ──────────────────────────────────────────────────────────────────────────────────
# The anonymous pull probe: token exchange, then the manifest, exactly as a host with no
# credentials would do it. 200 means the GPU host can pull this without a login.
public() {
  t=$(curl -fsS "https://$registry/token?scope=repository:$path:pull" \
        | sed -n 's/.*"token":"\([^"]*\)".*/\1/p')
  curl -fsS -o /dev/null -H "Authorization: Bearer $t" \
    -H "Accept: application/vnd.oci.image.index.v1+json, application/vnd.docker.distribution.manifest.v2+json" \
    "https://$registry/v2/$path/manifests/$sha" 2>/dev/null
}
if public; then
  echo "$IMAGE is anonymously pullable."
elif gh api -X PATCH "/user/packages/container/$package" -f private=false >/dev/null 2>&1 && public; then
  echo "$IMAGE is now public (it was created private by the first push)."
else
  echo "Not anonymously pullable yet. GitHub -> Your profile -> Packages -> $package ->"
  echo "  Package settings -> Danger Zone -> Change visibility -> Public."
  echo "Or: gh api -X PATCH /user/packages/container/$package -f private=false"
fi

echo
echo "Komodo: paste this (deploy/stack.yml with the image pinned to $sha) --"
sed "s|^\([[:space:]]*image:\).*|\1 ${IMAGE}:${sha}|" deploy/stack.yml | sed 's/^/  /'
