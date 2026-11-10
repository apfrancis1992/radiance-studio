# The GUI is a directory of static files and an nginx in front of them, so the image is nginx plus
# those files: no build stage, no node_modules, no npm at build time.
#
# The config is a template the stock entrypoint envsubst's at container start, so one image serves
# any llama-swap: pointing it somewhere else is an environment variable and a restart, never a
# rebuild. The ENV block below is the only place a default is written twice.

ARG NGINX_IMAGE=docker.io/nginx:alpine
FROM ${NGINX_IMAGE}

# Every ${VAR} the template uses. A Komodo stack or `docker run -e` overrides any of them; the
# entrypoint substitutes them all, so none may be left undefined.
ENV PORT=8090 \
    UPSTREAM_URL=http://127.0.0.1:8080 \
    UPSTREAM_API_KEY= \
    MODEL= \
    APP_TITLE="radiance studio" \
    STREAM_DEFAULT=true \
    MAX_DURATION=360 \
    DEFAULT_DURATION=30 \
    REQ_TIMEOUT=1800 \
    RESOLVER=127.0.0.11

COPY nginx/default.conf.template /etc/nginx/templates/default.conf.template
COPY public/ /usr/share/nginx/html/

# Not EXPOSEd: the stack shares the host's network, as radiance's own containers do, and the port
# is whatever PORT says at run time.
LABEL org.opencontainers.image.title="radiance-studio" \
      org.opencontainers.image.description="A web GUI for MiniMax-Music3 on radiance, behind llama-swap" \
      org.opencontainers.image.licenses="Apache-2.0"

HEALTHCHECK --interval=30s --timeout=5s --start-period=10s --retries=3 \
    CMD wget -q -O /dev/null "http://127.0.0.1:${PORT}/healthz" || exit 1
