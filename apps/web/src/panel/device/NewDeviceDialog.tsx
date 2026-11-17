import { useEffect, useState, type FormEvent } from 'react'
import { Button, Dialog, Spinner, TextField, ValuePicker } from '@latch/ui'
import { SIMULATOR_NAME, type SimulatorCatalogView } from '@latch/protocol'
import { api, errorMessage } from '../../core/api.ts'
import { parseCatalog, typesFor } from './model.ts'

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
  const nameError = trimmed && !SIMULATOR_NAME.test(trimmed) ? "只能用字母、数字、空格和 . _ ( ) ' -，不超过 64 个字符" : undefined

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
      title="新建设备"
      footer={
        <>
          <Button variant="secondary" onClick={onClose}>
            取消
          </Button>
          <Button
            variant="primary"
            loading={creating}
            disabled={!trimmed || nameError !== undefined || !runtime || !chosenType}
            onClick={() => void submit()}>
            新建
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
            label="名字"
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
            <span className="sim-new-label">系统</span>
            <ValuePicker
              label="系统版本"
              size="sm"
              value={runtime ?? ''}
              placeholder="没有可用的系统"
              options={(catalog?.runtimes ?? []).map(item => ({ value: item.id, label: item.name }))}
              onValueChange={setRuntime}
            />
          </div>
          <div className="sim-new-row">
            <span className="sim-new-label">设备</span>
            <ValuePicker
              label="设备类型"
              size="sm"
              value={chosenType ?? ''}
              placeholder="这个系统没有设备类型"
              searchable={types.length > 12}
              groups={['iPhone', 'iPad', '']
                .map(family => ({
                  id: family || 'other',
                  label: family || '其他',
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
