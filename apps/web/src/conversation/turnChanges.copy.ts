import { defineCopy, plural } from '../core/i18n.ts'

/** Why a turn cannot go back or forward, said once per action so that each language writes whole sentences. */
export const BLOCKED_COPY = defineCopy(
  {
    undo: {
      offline: '离线时不能撤销',
      running: '运行中不能撤销',
      notSettled: '这一轮没有正常结束，不能撤销',
      changedSince: '之后又改过这些文件，不能撤销',
      notRetained: '这些文件的内容没有留存，不能撤销',
    },
    redo: {
      offline: '离线时不能恢复',
      running: '运行中不能恢复',
      notSettled: '这一轮没有正常结束，不能恢复',
      changedSince: '之后又改过这些文件，不能恢复',
      notRetained: '这些文件的内容没有留存，不能恢复',
    },
  },
  {
    undo: {
      offline: 'Can’t undo offline',
      running: 'Can’t undo while running',
      notSettled: 'Turn didn’t finish, can’t undo',
      changedSince: 'Files changed since, can’t undo',
      notRetained: 'File contents weren’t kept, can’t undo',
    },
    redo: {
      offline: 'Can’t redo offline',
      running: 'Can’t redo while running',
      notSettled: 'Turn didn’t finish, can’t redo',
      changedSince: 'Files changed since, can’t redo',
      notRetained: 'File contents weren’t kept, can’t redo',
    },
  },
)

/** The words of taking a turn back, shared by the turn's card in the conversation and the 改动 tab. */
export const TURN_CHANGES_COPY = defineCopy(
  {
    sessionReadOnly: '这个会话只能查看',
    deviceReadOnly: '这台设备只能查看',
    notRetainedFile: (path: string) => `${path} · 内容没有留存`,
    secretFile: (path: string) => `${path} · 可能含密钥，不写也不删`,
    notCoveredFile: (path: string) => `${path} · 在文件夹之外或被忽略`,
    partialLabel: '记录不完整：文件夹太大',
    partialDetail: '超过 5 万项、32 层或 10 秒。可能还有没列出的文件，撤销也碰不到它们。',
    notRestored: (count: number) => plural(count, { other: '这 {n} 个文件没有恢复' }),
    notRestoredNamed: (count: number, named: number) => `${plural(count, { other: '这 {n} 个文件没有恢复' })}（列出前 ${named} 个）`,
    undoTurn: '撤销本轮',
    redo: '恢复',
    turnUndone: '已撤销本轮改动',
    turnRedone: '已恢复本轮改动',
    willNotRestore: (count: number) => plural(count, { other: '不会恢复 {n} 个文件' }),
    notCovered: (count: number) => plural(count, { other: '{n} 个文件不在撤销范围' }),
    notCoveredWhy: '它们在文件夹之外或被忽略。',
    nextMessageTells: (engine: string) => `下一条消息会告诉 ${engine}`,
    cancel: '取消',
  },
  {
    sessionReadOnly: 'This session is read only',
    deviceReadOnly: 'This device is read only',
    notRetainedFile: (path: string) => `${path} · contents not kept`,
    secretFile: (path: string) => `${path} · may hold secrets, left as is`,
    notCoveredFile: (path: string) => `${path} · outside the folder or ignored`,
    partialLabel: 'Incomplete record: folder too large',
    partialDetail: 'Over 50,000 items, 32 levels or 10 seconds. Some files may be missing here, and undo can’t reach them.',
    notRestored: (count: number) => plural(count, { one: '{n} file left as it was', other: '{n} files left as they were' }),
    notRestoredNamed: (count: number, named: number) =>
      `${plural(count, { one: '{n} file left as it was', other: '{n} files left as they were' })} (first ${named} listed)`,
    undoTurn: 'Undo turn',
    redo: 'Redo',
    turnUndone: 'Turn undone',
    turnRedone: 'Turn redone',
    willNotRestore: (count: number) => plural(count, { one: '{n} file will be left as is', other: '{n} files will be left as they are' }),
    notCovered: (count: number) => plural(count, { one: '{n} file outside undo', other: '{n} files outside undo' }),
    notCoveredWhy: 'They’re outside the folder or ignored.',
    nextMessageTells: (engine: string) => `The next message tells ${engine}`,
    cancel: 'Cancel',
  },
)
