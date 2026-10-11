// One-shot local visual diagnosis. Requires functions/.secret.local; never prints keys or vehicle IDs.
// At most two GBIS route requests and one GBIS location request, reserved in the emulator file ledger.
import { createServer } from 'vite'
import react from '@vitejs/plugin-react'
import { createRequire } from 'node:module'
import { readFileSync, mkdtempSync, writeFileSync } from 'node:fs'
import { spawn } from 'node:child_process'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import assert from 'node:assert/strict'

process.env.FUNCTIONS_EMULATOR = 'true'
process.env.GBIS_BUDGET_STORE = 'file'
const require = createRequire(import.meta.url)
const key = /^PUBLIC_DATA_SERVICE_KEY=(.*)$/m.exec(readFileSync(new URL('../functions/.secret.local', import.meta.url), 'utf8'))?.[1]?.trim()
if (!key) throw new Error('Local service key unavailable')
const { shapeGbisRoute, stopsGbisRoute, vehiclesGbisRoute } = require('../functions/lib/transit/gbis.js')
const routeId = '219000001'
const [shapeResult, stopResult] = await Promise.all([shapeGbisRoute(routeId, key), stopsGbisRoute(routeId, key)])
const vehicleResult = await vehiclesGbisRoute(routeId, key)
assert.ok(shapeResult.shape && stopResult.stops.length > 1, 'Live route data unavailable')
const route = { id: { provider: 'gbis', regionCode: 'gyeonggi', value: routeId }, name: '11',
  startName: stopResult.stops[0].name, endName: stopResult.stops.at(-1).name, typeName: null, regionName: '고양시',
  startStopId: stopResult.stops[0].id, endStopId: stopResult.stops.at(-1).id }
const firstStop = stopResult.stops[0]
const reply = (path) => {
  const queriedAt = new Date().toISOString(), source = 'gbis'
  if (path === '/api/stops/nearby') return { stops: [firstStop], queriedAt, source }
  if (path === `/api/stops/${firstStop.id.value}/arrivals`) return { arrivals: [{ routeId: route.id, stopId: firstStop.id,
    routeName: route.name, destination: null, operationStatus: 'unknown', visits: [] }], queriedAt, source }
  if (path === `/api/routes/${routeId}`) return { route, queriedAt, source }
  if (path === `/api/routes/${routeId}/shape`) return shapeResult
  if (path === `/api/routes/${routeId}/stops`) return stopResult
  if (path === `/api/routes/${routeId}/vehicles`) return vehicleResult
  return null
}
const server = await createServer({ configFile: false, plugins: [react(), { name: 'one-shot-live-data',
  configureServer(vite) { vite.middlewares.use('/api', (req, res) => {
    const path = `/api${new URL(req.url ?? '', 'http://localhost').pathname}`
    const body = reply(path)
    res.writeHead(body ? 200 : 404, { 'Content-Type': 'application/json; charset=utf-8' })
    res.end(JSON.stringify(body ?? { error: 'NOT_FOUND', message: 'No fixture' }))
  }) },
}], server: { host: '127.0.0.1', port: 5173, strictPort: true } })
const delay = (ms) => new Promise((resolve) => setTimeout(resolve, ms))
const profile = mkdtempSync(join(tmpdir(), 'bustracker-live-ui-'))
let chrome, socket
try {
  await server.listen()
  chrome = spawn('C:\\Program Files\\Google\\Chrome\\Application\\chrome.exe',
    ['--headless=new', '--no-first-run', '--no-default-browser-check', '--disable-gpu', '--remote-debugging-port=9225',
      `--user-data-dir=${profile}`, '--window-size=1440,900', 'about:blank'], { windowsHide: true, stdio: 'ignore' })
  let page
  for (let attempt = 0; attempt < 60; attempt++) {
    try { page = (await fetch('http://127.0.0.1:9225/json/list').then((res) => res.json())).find((tab) => tab.type === 'page') }
    catch { /* Chrome starting. */ }
    if (page) break
    await delay(250)
  }
  assert.ok(page, 'Chrome DevTools unavailable')
  socket = new WebSocket(page.webSocketDebuggerUrl)
  const pending = new Map()
  let serial = 0
  socket.onmessage = ({ data }) => {
    const response = JSON.parse(data)
    if (response.id) { pending.get(response.id)?.(response); pending.delete(response.id) }
  }
  await new Promise((resolve, reject) => { socket.onopen = resolve; socket.onerror = reject })
  const send = (method, params = {}) => new Promise((resolve, reject) => {
    const id = ++serial
    pending.set(id, (response) => response.error ? reject(new Error(response.error.message)) : resolve(response.result))
    socket.send(JSON.stringify({ id, method, params }))
  })
  const evaluate = async (expression) => {
    const value = await send('Runtime.evaluate', { expression, returnByValue: true, awaitPromise: true })
    if (value.exceptionDetails) throw new Error('Browser evaluation failed')
    return value.result.value
  }
  const until = async (expression, label) => {
    for (let attempt = 0; attempt < 80; attempt++) { if (await evaluate(expression)) return; await delay(250) }
    throw new Error(`${label} timed out`)
  }
  await send('Page.enable'); await send('Runtime.enable')
  await send('Emulation.setDeviceMetricsOverride', { width: 1440, height: 900, deviceScaleFactor: 1, mobile: false })
  await send('Page.navigate', { url: 'http://localhost:5173/' })
  await until('!!document.querySelector(".stop-row")', 'stop')
  await evaluate('document.querySelector(".stop-row").click()')
  await until('!!document.querySelector(".route-number")', 'arrival')
  await evaluate('document.querySelector(".route-number").click()')
  await until('!!document.querySelector(".selected-route .route-stop-row")', 'route stops')
  await until('!!document.querySelector(".vehicle-summary") || !!document.querySelector(".vehicle-group .route-error")', 'vehicles')
  await delay(600)
  const full = await send('Page.captureScreenshot', { format: 'png' })
  const fullPath = join(tmpdir(), 'bustracker-live-11-full.png')
  writeFileSync(fullPath, Buffer.from(full.data, 'base64'))
  const usable = await evaluate('document.querySelector(".vehicle-summary")?.textContent')
  const initialList = await evaluate(`(() => {const list=document.querySelector('.route-stop-list'), icon=list?.querySelector('.route-stop-vehicles'); if(!list||!icon)return null; const a=list.getBoundingClientRect(), b=icon.getBoundingClientRect(), parts=icon.previousElementSibling?.dataset.routeStop?.split(':'); return {scrollTop:list.scrollTop, visible:b.top>=a.top&&b.bottom<=a.bottom, firstSequence:parts?.at(-2)??null}})()`)
  assert.equal(initialList?.visible, true, 'The first verified vehicle must be visible in the stop list')
  const arrowCount = await evaluate('document.querySelectorAll(".route-direction-arrow").length')
  const level = await evaluate('document.querySelector(".map-legend") ? document.querySelector(".zoom-hint")?.textContent ?? null : null')
  const firstVerified = await evaluate('(() => {const button=document.querySelector(".vehicle-list-toggle"); if(!button)return false; button.click(); const row=[...document.querySelectorAll(".vehicle-row")].find(x=>x.textContent?.includes("구간 기준 위치")); if(!row)return false; row.click(); return true})()')
  if (firstVerified) await delay(700)
  const focusedArrowCount = await evaluate('document.querySelectorAll(".route-direction-arrow").length')
  const focused = await send('Page.captureScreenshot', { format: 'png' })
  const focusedPath = join(tmpdir(), 'bustracker-live-11-section.png')
  writeFileSync(focusedPath, Buffer.from(focused.data, 'base64'))
  await evaluate('document.querySelectorAll(".route-direction-arrow").forEach(x=>x.style.display="none")')
  const noArrows = await send('Page.captureScreenshot', { format: 'png' })
  const noArrowsPath = join(tmpdir(), 'bustracker-live-11-no-arrows.png')
  writeFileSync(noArrowsPath, Buffer.from(noArrows.data, 'base64'))
  const mapMetrics = await evaluate('(() => {const c=window.__BUS_TRACKER_MAP_METRICS__?.counters;return c?{polylines:c.polylineCreated-c.polylineRemoved,overlays:c.overlayCreated-c.overlayRemoved}:null})()')
  const listIcons = await evaluate('document.querySelectorAll(".route-stop-vehicles").length')
  const mapIcons = await evaluate('document.querySelectorAll(".section-bus-icon").length')
  process.stdout.write(JSON.stringify({ route: '11', vehicleCount: vehicleResult.vehicles.length,
    sectionVerifiedCount: vehicleResult.vehicles.filter((vehicle) => vehicle.sectionVerified).length,
    listIcons, initialList, mapIcons, arrowCount, focusedArrowCount, firstVerified, summaryPresent: Boolean(usable), zoomHint: level, mapMetrics,
    screenshots: [fullPath, focusedPath, noArrowsPath] }) + '\n')
} finally {
  socket?.close()
  chrome?.kill()
  await server.close()
}
