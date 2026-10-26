# Native TLS helper

Unix-only Go standard-library TLS boundary, built without CGO or third-party modules. The Node Host owns knock/preflight, current device authority, Root proof, HTTP/2 and application state.

- Configuration arrives only on private stdin; ciphertext and application data use inherited FD 3/4. No listener, configuration path, certificate or key in arguments/environment/logs. The Host Root private key never enters the helper.
- Require TLS 1.3, the binding-selected h2 or latch-pad/1 ALPN, exact SNI, no tickets/resumption/0-RTT. Registered clients require platform certificate-chain verification plus exact pre-enrolled SPKI, current validity and self-signature; pairing requests no client certificate.
- One helper per accepted connection, three-second handshake deadline, fixed copy buffers. The Node adapter caps processes and kills/awaits only its own children on cancellation or shutdown.
- Keep Go source formatted with gofmt. Systematic tests remain Vitest in ../test/; do not add separate Go or shell test runners.
