import { chmod, mkdir, writeFile } from 'node:fs/promises'
import { join } from 'node:path'

/**
 * A stand-in `ssh` that serves the bare repositories under `served` with `git upload-pack`, and a shell whose PATH
 * starts with it, for your-Git runners: an `ssh` address (`git@example.test:remote.git`) then goes through Git's ssh
 * transport as it would to a host, without a network. Each call is logged to `<marks>/ssh-calls`; while `hang` exists
 * it waits 30 seconds first.
 */
export async function installFakeSsh(input: { root: string; served: string; marks: string; git: string }) {
  const bin = join(input.root, 'fake-ssh-bin'),
    hang = join(input.root, 'fake-ssh-hang')
  await mkdir(bin, { recursive: true })
  const quote = (text: string) => `'${text.replaceAll("'", `'\\''`)}'`
  const ssh = join(bin, 'ssh')
  await writeFile(
    ssh,
    [
      '#!/bin/sh',
      `echo "$*" >> ${quote(join(input.marks, 'ssh-calls'))}`,
      `if [ -f ${quote(hang)} ]; then sleep 30; fi`,
      'for last; do :; done',
      `path=$(printf '%s' "$last" | sed -e "s/^git-upload-pack '//" -e "s/'$//")`,
      `cd ${quote(input.served)} && exec ${quote(input.git)} upload-pack "$path"`,
      '',
    ].join('\n'),
  )
  await chmod(ssh, 0o755)
  const shell = join(bin, 'shell')
  await writeFile(shell, `#!/bin/sh\nPATH=${quote(`${bin}:/usr/bin:/bin`)}; export PATH\nexec /bin/sh "$@"\n`)
  await chmod(shell, 0o755)
  return { hang, shell: async () => ({ file: shell, argv: ['sh'] }) }
}
