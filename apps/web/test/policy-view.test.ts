import { describe, expect, it } from 'vitest'
import { addressRows } from '../src/core/policyView.ts'

describe('confirmed addresses', () => {
  const providers = [
    { name: 'Ollama', baseURL: 'http://127.0.0.1:11434/v1/' },
    { name: 'Other', baseURL: 'https://api.example.test/v1' },
  ]

  it('pairs an address with the services at it and the allowance only it needs', () => {
    const { addresses, allowances } = addressRows(
      { confirmedAddresses: ['http://127.0.0.1:11434/v1'], hostEgressAllow: ['127.0.0.1:11434', '10.0.0.2:8080'] },
      providers,
    )
    expect(addresses).toEqual([
      { address: 'http://127.0.0.1:11434/v1', shown: 'http://127.0.0.1:11434/v1', services: ['Ollama'], allowance: '127.0.0.1:11434' },
    ])
    expect(allowances).toEqual(['10.0.0.2:8080'])
  })

  it('keeps an allowance another confirmed address still needs', () => {
    const { addresses } = addressRows(
      { confirmedAddresses: ['http://10.0.0.2:8080/a', 'http://10.0.0.2:8080/b'], hostEgressAllow: ['10.0.0.2:8080'] },
      [],
    )
    expect(addresses.map(row => row.allowance)).toEqual([undefined, undefined])
  })

  it('does not count a service at another path of the same origin as using the address', () => {
    const { addresses } = addressRows({ confirmedAddresses: ['https://api.example.test:443/v1/mine'], hostEgressAllow: [] }, providers)
    expect(addresses[0]!.services).toEqual([])
  })
})
