import { createContext } from 'react'
import type { FileOpenTarget } from '@latch/protocol'
export const FileOpenContext = createContext<((target: FileOpenTarget) => void) | undefined>(undefined)
