#!/bin/sh
# dev/run.sh -- build the image and run it against dev/mock-upstream.py, so the page can be clicked
# through with no GPU in the loop.
#
#   dev/run.sh            build, start the mock, serve the page on http://127.0.0.1:8090
#   dev/run.sh --no-build reuse the image
set -eu
cd "$(dirname "$0")/.."

IMAGE=${IMAGE:-radiance-studio:dev}
PORT=${PORT:-8090}
MOCK_PORT=${MOCK_PORT:-8123}

[ "${1:-}" = "--no-build" ] || docker build -t "$IMAGE" .

docker rm -f radiance-studio-dev >/dev/null 2>&1 || true
pkill -f "dev/mock-upstream.py" 2>/dev/null || true
python3 dev/mock-upstream.py --port "$MOCK_PORT" &
MOCK=$!
trap 'kill $MOCK 2>/dev/null; docker rm -f radiance-studio-dev >/dev/null 2>&1 || true' EXIT

# The same posture as the stack that ships: the host's own network, so the mock on the host's
# loopback is what UPSTREAM_URL points at, with no NAT and no port mapping in the way.
docker run -d --rm --name radiance-studio-dev \
  --network host \
  -e PORT="$PORT" \
  -e UPSTREAM_URL="http://127.0.0.1:$MOCK_PORT" \
  "$IMAGE" >/dev/null

echo "http://127.0.0.1:$PORT  (mock llama-swap on :$MOCK_PORT, ctrl-c stops both)"
wait
