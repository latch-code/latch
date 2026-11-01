import { AppWindow, Laptop, Smartphone, Tablet } from 'lucide-react'
import type { Device } from '@latch/protocol'
import type { LucideIcon } from '@latch/ui'

export function deviceIcon(device: Pick<Device, 'listener' | 'name'>): LucideIcon {
  if (device.listener === 'native-direct' || device.listener === 'native-relay')
    return /ipad|平板/iu.test(device.name) ? Tablet : Smartphone
  return device.listener === 'unix' ? Laptop : AppWindow
}
