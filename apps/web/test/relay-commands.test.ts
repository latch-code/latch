import { expect, it } from 'vitest'
import { relayOrigin, relaySetupCommands } from '../src/settings/relayCommands.ts'

it('builds one Workers command from the name and location, and none from a name a path could not hold', () => {
  expect(relaySetupCommands('edge', { latch: 'pnpm latch', name: 'home' }).deploy).toEqual([
    'pnpm latch relay setup cloudflare --name home',
  ])
  expect(relaySetupCommands('edge', { name: 'home', location: 'apac-ne' }).deploy).toEqual([
    'latch relay setup cloudflare --name home --location apac-ne',
  ])
  for (const name of ['', 'Home', 'a b', 'x;rm', '-a', 'a'.repeat(41)]) expect(relaySetupCommands('edge', { name }).deploy).toEqual([])
  expect(relaySetupCommands('edge', { name: 'home', location: 'tokyo; rm' as never }).deploy).toEqual([
    'latch relay setup cloudflare --name home',
  ])
})

it('turns the server form into commands only when every answer is plain enough for a shell', () => {
  const form = {
    server: 'me@relay.example.com',
    domain: 'relay.example.com',
    port: '8443',
    cert: '/etc/ssl/chain.pem',
    key: '/etc/ssl/key.pem',
  }
  const commands = relaySetupCommands('self', form)
  expect(commands.login).toEqual(['ssh me@relay.example.com'])
  expect(commands.deploy[1]).toBe(
    'pnpm relay init --data-dir /srv/latch-relay --domain relay.example.com --port 8443 --cert /etc/ssl/chain.pem --key /etc/ssl/key.pem',
  )
  expect(commands.deploy[2]).toContain('--url https://relay.example.com:8443 --output /srv/latch-relay/latch-connection.json')
  expect(commands.fetch).toEqual([
    '(umask 077 && mkdir -p ~/.latch/relays) && scp me@relay.example.com:/srv/latch-relay/latch-connection.json ~/.latch/relays/relay-example-com.json',
  ])
  for (const bad of [
    { domain: 'Relay.example.com' },
    { domain: 'a_b.example.com' },
    { port: '0' },
    { cert: 'chain.pem' },
    { key: '/etc/ssl/$(id)' },
  ])
    expect(relaySetupCommands('self', { ...form, ...bad }).deploy).toEqual([])
  expect(relaySetupCommands('self', { ...form, server: 'me@host; id' })).toMatchObject({ login: [], fetch: [] })
  expect(relayOrigin('relay.example.com', '443')).toBe('https://relay.example.com')
})
