# prepare-image.ts supplies the reviewed immutable multi-architecture runtime index.
ARG RUNTIME_BASE
FROM ${RUNTIME_BASE}
COPY --chown=65532:65532 node /opt/latch/node
COPY --chown=65532:65532 latch-relay.mjs /opt/latch/latch-relay.mjs
COPY --chown=65532:65532 latch-relay-tls /opt/latch/latch-relay-tls
COPY --chown=65532:65532 latch-relay-tls.LICENSE /opt/latch/latch-relay-tls.LICENSE
COPY --chown=65532:65532 NODE-LICENSE /opt/latch/NODE-LICENSE
USER 65532:65532
WORKDIR /opt/latch
ENTRYPOINT ["/opt/latch/node", "--disable-sigusr1", "/opt/latch/latch-relay.mjs"]
CMD ["start", "--data-dir", "/var/lib/latch-relay"]
