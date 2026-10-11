const { test } = require('node:test')
const assert = require('node:assert/strict')
const { readdirSync, readFileSync } = require('node:fs')
const { join, resolve } = require('node:path')

const base = 'http://localhost:5000'
async function request(path, options) { return fetch(`${base}${path}`, { ...options, signal: AbortSignal.timeout(5000) }) }

test('invalid coordinates, search terms, methods and paths are rejected before upstream calls', async () => {
  assert.equal((await request('/api/stops/nearby?lat=999&lng=126.832')).status, 400)
  assert.equal((await request('/api/stops/nearby?lat=37.658&lng=invalid')).status, 400)
  assert.equal((await request(`/api/routes/search?q=${'x'.repeat(31)}`)).status, 400)
  assert.equal((await request('/api/routes/not-a-number/vehicles')).status, 404)
  const missing = await request('/api/unsupported')
  assert.equal(missing.status, 404)
  assert.match(missing.headers.get('content-type') ?? '', /application\/json/)
  assert.equal((await request('/api/health', { method: 'POST' })).status, 405)
})

test('cross-origin requests do not receive a permissive CORS header in the emulator', async () => {
  const response = await request('/api/health', { headers: { Origin: 'https://example.invalid' } })
  assert.equal(response.headers.get('access-control-allow-origin'), null)
})

test('the built client contains no server Secret variable name', () => {
  const assets = resolve(__dirname, '../dist/assets')
  for (const file of readdirSync(assets).filter((name) => name.endsWith('.js'))) {
    const code = readFileSync(join(assets, file), 'utf8')
    assert.equal(code.includes('PUBLIC_DATA_SERVICE_KEY'), false)
    assert.equal(code.includes('.secret.local'), false)
  }
})
