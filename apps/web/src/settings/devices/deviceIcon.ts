import { AppWindow, Tablet } from 'lucide-react'
import { LaptopGlyph, PhoneGlyph } from '@latch/ui'
import type { Device } from '@latch/protocol'
import type { IconComponent } from '@latch/ui'

export function deviceIcon(device: Pick<Device, 'listener' | 'name'>): IconComponent {
  if (device.listener === 'native-direct' || device.listener === 'native-relay')
    return /ipad|平板/iu.test(device.name) ? Tablet : PhoneGlyph
  return device.listener === 'unix' ? LaptopGlyph : AppWindow
}
