Third-party software and assets distributed with Latch

Latch itself is under the MIT License (LICENSE at the repository root). The components below keep their own licences;
their texts are in the folders beside this file.

Brand icons

Sources, licences and the trademark statement are in brands/SOURCES.txt; the icon set's licence is in
brands/LICENSE-lobe-icons.txt, each project's copyright lines in brands/NOTICE-brands.txt and the Apache License 2.0
in brands/LICENSE-Apache-2.0.txt.

File type icons

Material Icon Theme provides file associations and SVG icons under MIT. Its icon sources
and their license terms, including Apache 2.0, are in file-types/ beside this file.

Document previews

The preview dependency tree is made of unmodified packages. Browser bundles omit
Node-only optional canvas backends. Their license texts are
distributed in preview/ beside this file (served under /link/licenses/preview/).
JSZip is used under its MIT license option. PDF CMaps carry Adobe notices; the standard fonts
carry their Foxit and SIL Open Font License notices, copied with the font assets.

@aiden0z/pptx-renderer 1.4.0 also embeds unmodified mtx-decompressor 1.4.2 code under MPL-2.0.
Its corresponding source is https://github.com/ChristopherVR/mtx-decompressor/tree/v1.4.2 ;
the separately resolved dependency is 1.8.0, https://github.com/ChristopherVR/mtx-decompressor/tree/v1.8.0 .
The MPL-2.0 copy and the upstream DrawingML geometry notices are in
preview/aiden0z-pptx-renderer/upstream/ and preview/aiden0z-pptx-renderer/THIRD_PARTY_NOTICES.md.
Bundling/minification does not change the source files; no renderer source fork is shipped.

Rich text rendering

Shiki 4.5.0 (core, JavaScript regex engine and grammars), KaTeX 0.19.0, remark-math 6.0.0 and Mermaid 12.2.0 are distributed with their dependency notices in rich/ beside this file. These dependencies run only in the documented worker, DOM or opaque-frame boundary. The selected TextMate grammars (JavaScript, TypeScript, JSX, TSX, JSON, JSONC, Python, Bash/shell, HTML, CSS, SCSS, Markdown, YAML, TOML, SQL, Rust, Go, Java, Kotlin, Swift, C, C++, C#, Ruby, PHP, Dockerfile, diff, XML and Vue) are supplied by @shikijs/langs under its included MIT license. KaTeX fonts retain its included MIT license.

Mermaid uses elkjs under EPL-2.0; the complete upstream source is available at https://github.com/kieler/elkjs/tree/v0.9.3. Khroma uses MIT; its package omits the manifest license field, and the upstream LICENSE is retained alongside the distribution. No package install scripts are executed.

Go runtime

The native TLS component links the Go standard library. Copyright 2009 The Go Authors.
Its BSD license is retained in packages/link-client/native/GO-LICENSE and copied beside the built component.

The standalone relay TLS gateway and supervisor link the Go standard library (BSD-3-Clause). Its full license is retained in apps/relay/gateway/GO-LICENSE and distributed next to dist/relay/latch-relay-tls as latch-relay-tls.LICENSE.
