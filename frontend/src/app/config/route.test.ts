import { describe, it, expect, beforeEach, afterEach } from 'vitest'
import { GET } from './route'

describe('GET /config', () => {
  const originalEnv = process.env

  beforeEach(() => {
    process.env = { ...originalEnv }
    delete process.env.API_URL
    delete process.env.NEXT_PUBLIC_API_URL
  })

  afterEach(() => {
    process.env = originalEnv
  })

  it('uses same-origin API requests by default, including for HTTPS sign-in', async () => {
    const response = await GET()
    expect(await response.json()).toEqual({ apiUrl: '' })
    expect(response.headers.get('cache-control')).toBe('no-store')
  })

  it('honors an explicitly configured public API URL', async () => {
    process.env.API_URL = 'https://api.example.com'
    const response = await GET()
    expect(await response.json()).toEqual({ apiUrl: 'https://api.example.com' })
  })

  it('honors the build-time URL when API_URL is absent', async () => {
    process.env.NEXT_PUBLIC_API_URL = 'https://api.example.com'
    const response = await GET()
    expect(await response.json()).toEqual({ apiUrl: 'https://api.example.com' })
  })
})
