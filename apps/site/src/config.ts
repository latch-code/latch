// Links that go live when the builds and the repository are published. An empty value means "not yet": the
// download buttons say so on click and the GitHub links show a short note. Fill them in, then rebuild.
const pluginMarket = 'https://github.com/latch-code/plugin-market'

export const LINKS = {
  mac: '',
  ios: '',
  github: 'https://github.com/latch-code/latch',
  pluginGuide: 'https://github.com/latch-code/latch/blob/main/docs/PLUGIN-DEVELOPMENT.md',
  pluginMarket,
  // The market repository's publishing guide.
  pluginPublish: `${pluginMarket}/blob/main/CONTRIBUTING.md`,
}
