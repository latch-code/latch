import { defineCopy } from '../core/i18n.ts'

/** Words shared by the settings sections: their names, the ways back and the plain actions. */
export const SETTINGS_COPY = defineCopy(
  {
    loading: '正在读取…',
    save: '保存',
    cancel: '取消',
    retry: '重试',
    remove: '移除',
    removeTitle: (name: string) => `移除 ${name}？`,
    back: '返回',
    backTo: (name: string) => `返回${name}`,
  },
  {
    loading: 'Loading…',
    save: 'Save',
    cancel: 'Cancel',
    retry: 'Retry',
    remove: 'Remove',
    removeTitle: (name: string) => `Remove ${name}?`,
    back: 'Back',
    backTo: (name: string) => `Back to ${name}`,
  },
)
