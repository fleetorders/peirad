# dokimd

## 0.1.0

### Minor Changes

- Initial release: contract-test an agent-harness integration against the
  harness actually installed. Probes for command presence, version,
  CLI flags, config keys, registered hooks, and transcript fields; a dated
  verdict naming the version checked; `degraded` vs `blocked` registers and a
  non-zero exit on any drift, for CI or scheduled use.
