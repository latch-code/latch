import { createContext } from 'react'

/** Opens 设置 › 扩展, on one Harness's page when given its ID; absent where this device cannot see that section. */
export const OpenExtensions = createContext<((harnessId?: string) => void) | undefined>(undefined)
