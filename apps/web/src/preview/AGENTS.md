# Document previews

Edit and preview rules the Host keeps are in ARCHITECTURE「改动与文件编辑」.

The UI in this directory is browser code. `office-frame.ts` is a separate IIFE entry point that runs only in an opaque `sandbox="allow-scripts"` frame. `zip.ts` and `xlsx.ts` parse Office data only there; do not import them into the main app. `csv.worker.ts` parses CSV in a dedicated worker. `PdfPreview.tsx` uses the PDF core API and its dedicated worker, never the viewer or annotation-layer DOM. `highlight.worker.ts` returns bounded text/role tokens. `diagram-frame.ts` is a separate Mermaid IIFE with the same opaque frame boundary.

- The parent sends one authorized file's bytes, kind, nonce and bounded display options. Secrets, approvals, snapshots, paths, arbitrary URLs and credentials never enter the frame. The parent owns authentication, the frame URL/CSP, source/origin/nonce checks, timeout and frame destruction.
- Window messages only establish one MessageChannel. Both sides validate finite commands and events (`types.ts`); spreadsheet pages contain at most 1,000 rows, 200 columns and one million characters. Never return document objects, prototypes or raw exception messages.
- Excerpts need a current parent request ID and version, at most 2,000 characters and a page index. The parent adds file identity and stamp. Only append editable drafts; never send automatically. Preserve the view on updates, pin reads to one ETag, and clear on authorization loss.
- Inspect ZIP limits before inflation and count actual output. Reject encrypted, traversing, oversized or unsupported ZIP64 archives. Bound PPT shapes and XML elements before DOM parsing. Remove external relationships before rendering; CSP blocks network, workers, subframes, objects, forms and navigation.
- Retain page/fit/10–400% zoom only for the same file identity. External DOCX links become internal anchors before rendering; only a trusted click and the parent's active user gesture may open the finite mapped URL. Scripted clicks never open links.
- Spreadsheet formulas are never evaluated. Display cached values, show when a cache is missing, preserve 1900/1904 dates, and mark truncation. CSV remains text, including strings that start with a formula character.
- PDF range requests convert the library's exclusive end to the parent's inclusive end (`end - 1`). Only the fixed CMap/font directories and validated resource basenames may be fetched. Disable XFA, WASM, automatic fetch and streaming; do not invoke PDF scripting APIs.
- Terminate workers, cancel loads/renders, close ports and revoke renderer resources on file/version changes and unmount. Product chrome uses UI tokens; PDF selection geometry and Office content preserve document-space typography.
- Session and workspace file contexts have separate tabs; workspace requests always name the selected Harness. Tree reads are lazy, cancellable and paged; never follow a symlink or save bytes/handles in browser storage.
- File history uses recorded tool diffs and frozen root IDs. Keep both sides' line numbers and unknown previous-content warnings; split review expands the desktop pane, while phones stay unified.
- Keep Markdown URL/depth rules and the math DOM allowlist. Render, zoom and download only lexer-validated diagram images; touch and WebKit render on demand. Never use HTML string sinks or a default Trusted Types policy.
- HTML DOMParser stays in `html-frame.ts`. Static mode strips document scripts; `html-script` is only offered by a desktop shell that declares network restrictions. Never pass a secret, session state or another file to either variant. `html-canvas.ts`: frame-only.
- Dependency versions live in the catalog. Preserve distributed licenses and corresponding-source links in `public/licenses/` and its `README.txt`.

Focused coverage: `apps/web/test/preview-data.test.ts` and `e2e/preview-renderers.e2e.ts`. The latter uses only a temporary-port Vite fixture, generated documents and the real browser; it does not connect a real Host.
