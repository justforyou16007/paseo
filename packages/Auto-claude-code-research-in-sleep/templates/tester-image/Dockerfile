# The tester container's base image: the Paseo image, the claude CLI the
# tester agent runs on, and a docker client for starting submission containers
# through the host's socket. Built and saved by
# `tester-agent-cli.js ensure-base-image`; see skills/tester-setup/SKILL.md.

ARG PASEO_IMAGE=ghcr.io/getpaseo/paseo:latest
FROM docker:cli AS docker-cli

FROM ${PASEO_IMAGE}

USER root
# The static client only; the daemon it talks to is the host's.
COPY --from=docker-cli /usr/local/bin/docker /usr/local/bin/docker
RUN npm install -g @anthropic-ai/claude-code

# Leave the image user as root. The Paseo entrypoint prepares mounted volumes,
# then drops the daemon and the agents it launches to the `paseo` user.
