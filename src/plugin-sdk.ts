// `latch/plugin-sdk`, kept so plugins written against the root package keep compiling, also where a plugin installed the
// package under its name from before the rename. It re-exports a types-only subpath of @latch/sdk: outside projects
// check these sources with their own options, and without allowImportingTsExtensions they reject the package index,
// whose `export *` statements name `.ts` files.
export * from '@latch/sdk/plugins'
