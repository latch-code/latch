// `harness-link/plugin-sdk`, kept so plugins written against the root package name keep compiling. It re-exports a
// types-only subpath of @latch/sdk: outside projects check these sources with their own options, and without
// allowImportingTsExtensions they reject the package index, whose `export *` statements name `.ts` files.
export * from '@latch/sdk/plugins'
