import type { QRCodeToDataURLOptions } from 'qrcode'

/** Load only when an invitation actually needs pixels. Never cache invitation text or rendered credentials. */
export async function pairingQr(payload: string, options: QRCodeToDataURLOptions): Promise<string> {
  const { default: QRCode } = await import('qrcode')
  return QRCode.toDataURL(payload, options)
}
