# The tester container's base image: the Paseo image, the claude CLI the
# tester agent runs on, and a docker client for starting submission containers
# through the host's socket. Built and saved by
# `tester-agent-cli.js ensure-base-image`; see skills/tester-setup/SKILL.md.
#
# Nothing here runs as root. The Paseo daemon and its agents run as `paseo`,
# so claude is installed by an ordinary account and copied in owned by
# `paseo`, and the image starts as `paseo`.

ARG PASEO_IMAGE=ghcr.io/getpaseo/paseo:latest
ARG NODE_IMAGE=node:22-bookworm-slim

FROM docker:cli AS docker-cli

FROM ${NODE_IMAGE} AS claude
USER node
RUN npm install --prefix /home/node/claude @anthropic-ai/claude-code

FROM ${PASEO_IMAGE}
# The static client only; the daemon it talks to is the host's.
COPY --from=docker-cli /usr/local/bin/docker /usr/local/bin/docker
# Kept out of /home/paseo: that path is a volume, and a volume made by an
# older image would hide a newer install.
COPY --from=claude --chown=paseo:paseo /home/node/claude /opt/claude
ENV PATH=/opt/claude/node_modules/.bin:${PATH}

# Starting as `paseo` makes the entrypoint skip its chown and gosu steps, so
# the socket group `docker run --group-add` gives the container stays on the
# daemon and every agent it starts.
USER paseo
