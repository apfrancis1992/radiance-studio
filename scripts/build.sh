#!/bin/sh
# Build the image locally. Pass a tag; with none it builds radiance-studio:<commit> and also tags
# that radiance-studio:latest, which is what deploy/stack.yml and dev/run.sh expect by default.
set -eu
cd "$(dirname "$0")/.."
tag=${1:-radiance-studio:$(git rev-parse --short HEAD 2>/dev/null || echo dev)}
docker build -t "$tag" .
[ -n "${1:-}" ] || docker tag "$tag" radiance-studio:latest
echo "built $tag"
