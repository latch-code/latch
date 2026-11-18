import { Fragment, useRef, useState } from 'react'

import { escapeSecurityText, isFileDirectoryListing, type FileContext, type FileDirectoryListing } from '@latch/protocol'
import { Icon, Menu, MenuFooterNote, CheckGlyph, ChevronRightGlyph, InfoGlyph } from '@latch/ui'
import { api } from '../core/api.ts'
import { defineCopy, plural } from '../core/i18n.ts'
import { referenceIcon } from '../fileReference.ts'
import { VisibleText } from '../components/VisibleText.tsx'
import { fileContextBody, fileRoute } from './fileContext.ts'

const MENU_FILES = 100

const COPY = defineCopy(
  {
    loading: '正在读取…',
    unavailable: '读不到这个文件夹',
    noOtherFiles: '这里没有其他文件',
    firstFiles: (count: number) => plural(count, { other: '只列出前 {n} 个文件' }),
    contents: (name: string) => `${name} 里的文件`,
    location: '文件位置',
    attachments: '消息附件',
  },
  {
    loading: 'Loading…',
    unavailable: 'Could not read this folder',
    noOtherFiles: 'No other files here',
    firstFiles: (count: number) => plural(count, { one: 'Showing only the first file', other: 'Showing only the first {n} files' }),
    contents: (name: string) => `Files in ${name}`,
    location: 'File location',
    attachments: 'Message attachments',
  },
)

/** The folders a file sits in, each with the listing its menu reads. The root's name stands for the empty path. */
export function breadcrumbFolders(rootName: string, path: string): Array<{ name: string; dir: string }> {
  const parts = path.split('/').slice(0, -1)
  return [{ name: rootName, dir: '' }, ...parts.map((name, index) => ({ name, dir: parts.slice(0, index + 1).join('/') }))]
}

/** A folder and the chevron after it open one menu: the files beside the one on show, read when asked for. */
function FolderCrumb({
  context,
  root,
  name,
  dir,
  current,
  onOpen,
}: {
  context: FileContext
  root: string
  name: string
  dir: string
  current: string
  onOpen(path: string): void
}) {
  const [listing, setListing] = useState<FileDirectoryListing | 'failed'>()
  const reading = useRef<AbortController | undefined>(undefined)
  const read = () => {
    reading.current?.abort()
    const controller = new AbortController()
    reading.current = controller
    const params = new URLSearchParams({ ...fileContextBody(context), rootId: root, dir, showHidden: 'false' })
    void api<unknown>(`${fileRoute(context, 'list')}?${params}`, { signal: controller.signal })
      .then(result => {
        if (!controller.signal.aborted) setListing(isFileDirectoryListing(result) ? result : 'failed')
      })
      .catch(() => {
        if (!controller.signal.aborted) setListing('failed')
      })
  }
  const files = listing && listing !== 'failed' ? listing.entries.filter(entry => entry.kind === 'file') : []
  const state =
    listing === undefined
      ? COPY.loading
      : listing === 'failed'
        ? COPY.unavailable
        : files.length === 0
          ? COPY.noOtherFiles
          : files.length > MENU_FILES || listing.truncated
            ? COPY.firstFiles(Math.min(files.length, MENU_FILES))
            : undefined
  return (
    <Menu
      label={COPY.contents(name)}
      {...(state ? { footer: <MenuFooterNote icon={InfoGlyph}>{state}</MenuFooterNote> } : {})}
      sections={[
        {
          id: 'files',
          items: files.slice(0, MENU_FILES).map(entry => {
            const path = dir ? `${dir}/${entry.name}` : entry.name
            return {
              id: path,
              label: escapeSecurityText(entry.name),
              icon: path === current ? CheckGlyph : referenceIcon(entry.name),
              onSelect: () => {
                onOpen(path)
              },
            }
          }),
        },
      ]}
      trigger={props => (
        <button
          {...props}
          type="button"
          className="file-crumb"
          onClick={() => {
            if (!props['aria-expanded']) read()
            props.onClick()
          }}
          onKeyDown={event => {
            if (event.key === 'ArrowDown' && !props['aria-expanded']) read()
            props.onKeyDown(event)
          }}>
          <VisibleText text={name} />
          <Icon icon={ChevronRightGlyph} size={12} />
        </button>
      )}
    />
  )
}

/** Where the file on show lives. An attachment has no folder to walk, so it only names itself. */
export function FileBreadcrumb({
  context,
  root,
  rootName,
  path,
  name,
  attachment,
  browsable,
  onOpen,
}: {
  /** A device that cannot list folders sees where the file lives, with nothing to open. */
  browsable: boolean
  context: FileContext
  root?: string
  rootName: string
  path: string
  name: string
  attachment: boolean
  onOpen(path: string): void
}) {
  return (
    <nav className="file-crumbs" aria-label={COPY.location}>
      {attachment ? (
        <>
          <span className="file-crumb-plain">{COPY.attachments}</span>
          <Icon icon={ChevronRightGlyph} size={12} />
        </>
      ) : (
        breadcrumbFolders(rootName, path).map(folder =>
          browsable && root !== undefined ? (
            <FolderCrumb
              key={folder.dir}
              context={context}
              root={root}
              name={folder.name}
              dir={folder.dir}
              current={path}
              onOpen={onOpen}
            />
          ) : (
            <Fragment key={folder.dir}>
              <span className="file-crumb-plain">
                <VisibleText text={folder.name} />
              </span>
              <Icon icon={ChevronRightGlyph} size={12} />
            </Fragment>
          ),
        )
      )}
      <strong className="file-crumb-current" title={path}>
        <VisibleText text={name} />
      </strong>
    </nav>
  )
}
