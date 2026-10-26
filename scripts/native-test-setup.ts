import { buildNativeTlsHelper } from '@latch/host/build-native-tls'

export default async function setup(): Promise<void> {
  await buildNativeTlsHelper()
}
