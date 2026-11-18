import { useEffect, useState, type FormEvent } from 'react'
import { Button, Dialog, Spinner, TextField, ValuePicker } from '@latch/ui'
import { SIMULATOR_NAME, type SimulatorCatalogView } from '@latch/protocol'
import { api, errorMessage } from '../../core/api.ts'
import { parseCatalog, typesFor } from './model.ts'
import { defineCopy } from '../../core/i18n.ts'

const COPY = defineCopy(
  {
    nameRules: "只能用字母、数字、空格和 . _ ( ) ' -，不超过 64 个字符",
    newDevice: '新建设备',
    cancel: '取消',
    create: '新建',
    name: '名字',
    os: '系统',
    osVersion: '系统版本',
    noOS: '没有可用的系统',
    device: '设备',
    type: '设备类型',
    noTypes: '这个系统没有设备类型',
    other: '其他',
  },
  {
    nameRules: "Use only letters, numbers, spaces and . _ ( ) ' -. Limit 64 characters.",
    newDevice: 'New device',
    cancel: 'Cancel',
    create: 'Create',
    name: 'Name',
    os: 'OS',
    osVersion: 'OS version',
    noOS: 'No operating systems available',
    device: 'Device',
    type: 'Device type',
    noTypes: 'This OS has no device types',
    other: 'Other',
  },
)

/**
 * 新建设备: a name the person types, a system version and a device type from what simctl lists (`simctl create`). The
 * new device is not started.
 */
export function NewDeviceDialog({ open, onClose, onCreated }: { open: boolean; onClose: () => void; onCreated: (udid: string) => void }) {
  const [catalog, setCatalog] = useState<SimulatorCatalogView>()
  const [name, setName] = useState('')
  const [runtime, setRuntime] = useState<string>()
  const [deviceType, setDeviceType] = useState<string>()
  const [failure, setFailure] = useState<string>()
  const [creating, setCreating] = useState(false)

  useEffect(() => {
    if (!open) return
    setFailure(undefined)
    const controller = new AbortController()
    void api<unknown>('simulators/catalog', { signal: controller.signal, timeoutMs: 45_000 })
      .then(answer => {
        const parsed = parseCatalog(answer)
        setCatalog(parsed)
        const first = parsed.runtimes.at(-1)
        setRuntime(current => current ?? first?.id)
      })
      .catch(error => {
        if (!controller.signal.aborted) setFailure(errorMessage(error))
      })
    return () => controller.abort()
  }, [open])

  const types = catalog ? typesFor(catalog, runtime) : []
  const chosenType = types.some(type => type.id === deviceType) ? deviceType : types[0]?.id
  const trimmed = name.trim()
  const nameError = trimmed && !SIMULATOR_NAME.test(trimmed) ? COPY.nameRules : undefined

  const submit = async (event?: FormEvent) => {
    event?.preventDefault()
    if (!trimmed || nameError || !runtime || !chosenType) return
    setCreating(true)
    setFailure(undefined)
    try {
      const { udid } = await api<{ udid: string }>('simulators', {
        method: 'POST',
        body: { name: trimmed, deviceType: chosenType, runtime },
        timeoutMs: 90_000,
      })
      setName('')
      onCreated(udid)
    } catch (error) {
      setFailure(errorMessage(error))
    } finally {
      setCreating(false)
    }
  }

  return (
    <Dialog
      open={open}
      onClose={onClose}
      size="md"
      title={COPY.newDevice}
      footer={
        <>
          <Button variant="secondary" onClick={onClose}>
            {COPY.cancel}
          </Button>
          <Button
            variant="primary"
            loading={creating}
            disabled={!trimmed || nameError !== undefined || !runtime || !chosenType}
            onClick={() => void submit()}>
            {COPY.create}
          </Button>
        </>
      }>
      {catalog === undefined && !failure ? (
        <div className="sim-dialog-wait">
          <Spinner size={14} />
        </div>
      ) : (
        <form className="sim-new" onSubmit={event => void submit(event)}>
          <TextField
            label={COPY.name}
            value={name}
            maxLength={64}
            autoFocus
            spellCheck={false}
            autoComplete="off"
            placeholder="latch-iPhone"
            error={nameError ?? failure}
            onChange={event => setName(event.target.value)}
          />
          <div className="sim-new-row">
            <span className="sim-new-label">{COPY.os}</span>
            <ValuePicker
              label={COPY.osVersion}
              size="sm"
              value={runtime ?? ''}
              placeholder={COPY.noOS}
              options={(catalog?.runtimes ?? []).map(item => ({ value: item.id, label: item.name }))}
              onValueChange={setRuntime}
            />
          </div>
          <div className="sim-new-row">
            <span className="sim-new-label">{COPY.device}</span>
            <ValuePicker
              label={COPY.type}
              size="sm"
              value={chosenType ?? ''}
              placeholder={COPY.noTypes}
              searchable={types.length > 12}
              groups={['iPhone', 'iPad', '']
                .map(family => ({
                  id: family || 'other',
                  label: family || COPY.other,
                  options: types
                    .filter(type => (family ? type.family === family : type.family !== 'iPhone' && type.family !== 'iPad'))
                    .map(type => ({ value: type.id, label: type.name })),
                }))
                .filter(group => group.options.length > 0)}
              onValueChange={setDeviceType}
            />
          </div>
        </form>
      )}
    </Dialog>
  )
}
