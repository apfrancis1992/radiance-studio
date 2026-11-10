#!/bin/sh
# dev/run.sh -- build the image and run it against dev/mock-upstream.py, so the page can be clicked
# through with no GPU in the loop.
#
#   dev/run.sh            build, start the mocks, serve the page on http://127.0.0.1:8090
#   dev/run.sh --no-build reuse the image
#
# Two mocks, deliberately: one is the container's own llama-swap and the other is what the page's
# Settings -> "llama-swap to use" can choose, so the X-Upstream allow-list is exercised by the smoke
# test rather than assumed. The second one reports no model loaded (--idle), which is the other pill
# state the page can show.
set -eu
cd "$(dirname "$0")/.."

IMAGE=${IMAGE:-radiance-studio:dev}
PORT=${PORT:-8090}
MOCK_PORT=${MOCK_PORT:-8123}
OTHER_PORT=${OTHER_PORT:-8124}

[ "${1:-}" = "--no-build" ] || docker build -t "$IMAGE" .

docker rm -f radiance-studio-dev >/dev/null 2>&1 || true
pkill -f "dev/mock-upstream.py" 2>/dev/null || true
python3 dev/mock-upstream.py --port "$MOCK_PORT" &
MOCK=$!
python3 dev/mock-upstream.py --port "$OTHER_PORT" --id minimax-lab --idle &
OTHER=$!
trap 'kill $MOCK $OTHER 2>/dev/null; docker rm -f radiance-studio-dev >/dev/null 2>&1 || true' EXIT

# The same posture as the stack that ships: the host's own network, so the mock on the host's
# loopback is what UPSTREAM_URL points at, with no NAT and no port mapping in the way.
docker run -d --rm --name radiance-studio-dev \
  --network host \
  -e PORT="$PORT" \
  -e UPSTREAM_URL="http://127.0.0.1:$MOCK_PORT" \
  -e UPSTREAM_OPTIONS="[{\"label\":\"the other one\",\"url\":\"http://127.0.0.1:$OTHER_PORT\"}]" \
  -e MODEL=minimax-music3 \
  "$IMAGE" >/dev/null

echo "http://127.0.0.1:$PORT  (mocks on :$MOCK_PORT and :$OTHER_PORT, ctrl-c stops all three)"
wait
