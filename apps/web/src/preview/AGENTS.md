# Document previews

Read [DOCUMENT-PREVIEWS.md](../../../../docs/DOCUMENT-PREVIEWS.md) before changing parser, frame or worker behavior.

The UI in this directory is browser code. `office-frame.ts` is a separate IIFE entry point that runs only in an opaque `sandbox="allow-scripts"` frame. `zip.ts` and `xlsx.ts` parse Office data only there; do not import them into the main app. `csv.worker.ts` parses CSV in a dedicated worker. `PdfPreview.tsx` uses the PDF core API and its dedicated worker, never the viewer or annotation-layer DOM. `highlight.worker.ts` returns bounded text/role tokens. `diagram-frame.ts` is a separate Mermaid IIFE with the same opaque frame boundary.

- The parent sends one authorized file's bytes, kind, nonce and bounded display options. Secrets, approvals, snapshots, paths, arbitrary URLs and credentials never enter the frame. The parent owns authentication, the frame URL/CSP, source/origin/nonce checks, timeout and frame destruction.
- Window messages only establish one MessageChannel. Both sides validate finite commands and events (`types.ts`); spreadsheet pages contain at most 1,000 rows, 200 columns and one million characters. Never return document objects, prototypes or raw exception messages.
- Inspect the ZIP central directory before decompression and count actual streamed output. Reject encrypted, traversing, oversized and unsupported ZIP64 archives. Remove external relationships before any Office renderer runs; the frame CSP independently blocks network, workers, subframes, objects, forms and navigation.
- Spreadsheet formulas are never evaluated. Display cached values, show when a cache is missing, preserve 1900/1904 dates, and mark truncation. CSV remains text, including strings that start with a formula character.
- PDF range requests convert the library's exclusive end to the parent's inclusive end (`end - 1`). Only the fixed CMap/font directories and validated resource basenames may be fetched. Disable XFA, WASM, automatic fetch and streaming; do not invoke PDF scripting APIs.
- Terminate workers, cancel loads/renders, close ports and revoke renderer resources on file/version changes and unmount. Product chrome uses UI tokens; PDF selection geometry and Office content preserve document-space typography.
- Markdown keeps the message URL/depth rules. Math DOM must pass the namespace/tag/attribute allowlist; diagram SVG is checked by the bounded lexer and displayed only as an image. Never use an HTML string sink or a default Trusted Types policy.
- Dependency versions live in the catalog. Preserve distributed licenses and corresponding-source links in `NOTICE` and the public license directories.

Focused coverage: `apps/web/test/preview-data.test.ts` and `e2e/preview-renderers.e2e.ts`. The latter uses only a temporary-port Vite fixture, generated documents and the real browser; it does not connect a real Host.
