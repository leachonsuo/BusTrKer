// Browser regression using one sanitized production snapshot of GBIS Goyang 11.
// Vehicle identities were replaced before saving the fixture. No network transit API is called.
// The 19/7 and 18/6 responses below are synthetic updates from this one captured snapshot;
// they do not represent the user's two captures as consecutive observations.
import { createServer } from 'vite'
import react from '@vitejs/plugin-react'
import { spawn } from 'node:child_process'
import { readFileSync, mkdtempSync, writeFileSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import assert from 'node:assert/strict'

const fixture = JSON.parse(readFileSync(new URL('./fixtures/goyang-11-sanitized.json', import.meta.url), 'utf8'))
const routeId = '219000001'
const focusSequence = Number.parseInt(process.env.BUS_TRACKER_QA_FOCUS_SEQUENCE ?? '2', 10)
assert.ok(Number.isInteger(focusSequence) && focusSequence >= 1 && focusSequence <= fixture.stops.stops.length)
const nearPosition = process.env.BUS_TRACKER_QA_NEAR === '1' ? fixture.stops.stops[focusSequence - 1].position : null
const stops = fixture.stops.stops
const firstStop = stops[0]
const route = { id: fixture.vehicles.routeId, name: '11', startName: firstStop.name,
  endName: stops.at(-1).name, typeName: null, regionName: '고양시',
  startStopId: firstStop.id, endStopId: stops.at(-1).id }
const captured = fixture.vehicles.vehicles
assert.equal(captured.length, 18)
assert.equal(captured.filter((vehicle) => vehicle.sectionVerified).length, 7)
const demotedIndex = captured.findIndex((vehicle) => vehicle.sectionVerified &&
  (focusSequence <= 52 ? vehicle.stationSequence < 52 : vehicle.stationSequence >= 52))
assert.ok(demotedIndex >= 0)
let phase = 'first'
let secondQueryAtMs = 0
const requests = []
function response(path) {
  const queriedAt = new Date(Date.now() - 6_000).toISOString(), source = 'gbis'
  if (path === '/api/stops/nearby') return { stops: [firstStop], queriedAt, source }
  if (path === `/api/stops/${firstStop.id.value}/arrivals`) return { arrivals: [{ routeId: route.id, stopId: firstStop.id,
    routeName: route.name, destination: null, operationStatus: 'unknown', visits: [] }], queriedAt, source }
  if (path === `/api/routes/${routeId}`) return { route, queriedAt, source }
  if (path === `/api/routes/${routeId}/shape`) return { ...fixture.shape, queriedAt }
  if (path === `/api/routes/${routeId}/stops`) return { ...fixture.stops, queriedAt }
  if (path === `/api/routes/${routeId}/vehicles`) {
    if (phase === 'second') secondQueryAtMs = Date.parse(queriedAt)
    const vehicles = phase === 'first'
      ? [...captured, { ...captured.find((vehicle) => !vehicle.sectionVerified), vehicleId: '999999' }]
      : captured.map((vehicle, index) => index === demotedIndex
        ? { ...vehicle, stateCode: 1, nextStopId: null, sectionVerified: false } : vehicle)
    return { routeId: route.id, vehicles, queriedAt, source }
  }
  return null
}

const server = await createServer({ configFile: false, plugins: [react(), { name: 'sanitized-route-11',
  configureServer(vite) { vite.middlewares.use('/api', (req, res) => {
    const path = `/api${new URL(req.url ?? '', 'http://localhost').pathname}`
    const started = performance.now()
    const body = response(path)
    const status = body ? 200 : 404
    res.writeHead(status, { 'Content-Type': 'application/json; charset=utf-8', 'Date': new Date().toUTCString(),
      'Cache-Control': 'no-store' })
    const finish = () => {
      res.end(JSON.stringify(body ?? { error: 'NOT_FOUND', message: 'No fixture' }))
      if (path.endsWith('/vehicles')) requests.push({ phase, status, elapsedMs: Math.round(performance.now() - started) })
    }
    if (path.endsWith('/vehicles') && phase === 'second') setTimeout(finish, 600)
    else finish()
  }) },
}], server: { host: '127.0.0.1', port: 5173, strictPort: true } })

const delay = (ms) => new Promise((resolve) => setTimeout(resolve, ms))
const profile = mkdtempSync(join(tmpdir(), 'bustracker-operational-qa-'))
const debugPort = 12000 + Math.floor(Math.random() * 10000)
let chrome, socket
try {
  await server.listen()
  chrome = spawn('C:\\Program Files\\Google\\Chrome\\Application\\chrome.exe',
    ['--headless=new', '--no-first-run', '--no-default-browser-check', '--disable-gpu', '--host-resolver-rules=MAP localhost 127.0.0.1', `--remote-debugging-port=${debugPort}`,
      `--user-data-dir=${profile}`, '--window-size=1440,900', 'about:blank'], { windowsHide: true, stdio: 'ignore' })
  let page
  for (let attempt = 0; attempt < 60; attempt++) {
    try { page = (await fetch(`http://127.0.0.1:${debugPort}/json/list`).then((res) => res.json())).find((tab) => tab.type === 'page') }
    catch { /* Chrome starting. */ }
    if (page) break
    await delay(250)
  }
  assert.ok(page, 'Chrome DevTools unavailable')
  socket = new WebSocket(page.webSocketDebuggerUrl)
  const pending = new Map()
  let serial = 0
  const exceptions = []
  socket.onmessage = ({ data }) => {
    const message = JSON.parse(data)
    if (message.method === 'Runtime.exceptionThrown') exceptions.push(message.params.exceptionDetails.text)
    if (message.id) { pending.get(message.id)?.(message); pending.delete(message.id) }
  }
  await new Promise((resolve, reject) => { socket.onopen = resolve; socket.onerror = reject })
  const send = (method, params = {}) => new Promise((resolve, reject) => {
    const id = ++serial
    pending.set(id, (message) => message.error ? reject(new Error(message.error.message)) : resolve(message.result))
    socket.send(JSON.stringify({ id, method, params }))
  })
  const evaluate = async (expression) => {
    const result = await send('Runtime.evaluate', { expression, returnByValue: true, awaitPromise: true })
    if (result.exceptionDetails) throw new Error(`Browser evaluation failed: ${expression.slice(0, 70)}`)
    return result.result.value
  }
  const until = async (expression, label) => {
    for (let attempt = 0; attempt < 80; attempt++) { if (await evaluate(expression)) return; await delay(250) }
    throw new Error(`${label} timed out`)
  }
  await send('Page.enable'); await send('Runtime.enable')
  await send('Page.addScriptToEvaluateOnNewDocument', { source: `window.__sectionDrops=[];
    const originalInfo=console.info; console.info=(tag,details)=>{if(tag==='BUS_TRACKER_SECTION_DROP')window.__sectionDrops.push(details);originalInfo(tag,details)};
    ${nearPosition ? `Object.defineProperty(navigator,'geolocation',{configurable:true,value:{getCurrentPosition(success){success({coords:{latitude:${nearPosition.latitude},longitude:${nearPosition.longitude},accuracy:25}})}}})` : ''}` })
  await send('Emulation.setDeviceMetricsOverride', { width: 1440, height: 900, deviceScaleFactor: 1, mobile: false })
  await send('Page.navigate', { url: 'http://localhost:5173/' })
  await until('!!document.querySelector(".stop-row")', 'fixture stop')
  await evaluate('document.querySelector(".stop-row").click()')
  await until('!!document.querySelector(".arrival-row .route-number")', 'fixture arrival')
  await evaluate('document.querySelector(".arrival-row .route-number").click()')
  await until('document.querySelectorAll(".direction-choice").length===2', 'direction choices')
  assert.equal(requests.length, 0, 'preselection must not poll vehicles')
  assert.equal(await evaluate('document.querySelector(".direction-chooser")?.textContent?.includes("행신역 방면 경로를 미리 표시")'), true)
  const guideVisibility = async () => evaluate(`(() => {const map=document.querySelector('.map-panel').getBoundingClientRect();
    const panel=document.querySelector('.direction-chooser').getBoundingClientRect();
    const list=document.querySelector('.sidebar.mobile-open')?.getBoundingClientRect();
    const apart=(a,b)=>a.right<b.left||a.left>b.right||a.bottom<b.top||a.top>b.bottom;
    return [...document.querySelectorAll('.direction-map-pin')].map((pin)=>{const r=pin.getBoundingClientRect();
      return {label:pin.textContent,inside:r.left>=map.left&&r.right<=map.right&&r.top>=map.top&&r.bottom<=map.bottom,
        clear:apart(r,panel)&&(!list||apart(r,list)),
        x:Math.round(r.left+r.width/2),y:Math.round(r.top+r.height/2)}})})()`)
  let nearChooserPath = null
  let farChooserPath = null
  if (nearPosition) {
    assert.equal(await evaluate('!!document.querySelector(".direction-chooser")'), true)
    await until('document.querySelectorAll(".direction-map-pin").length===2', 'two direction guides on real ordered shapes')
    assert.ok((await guideVisibility()).every((guide) => guide.inside && guide.clear), 'both guides remain visible outside the chooser')
    assert.equal(await evaluate('new Set([...document.querySelectorAll(".direction-map-pin")].map((pin)=>pin.dataset.directionKey)).size'), 2)
    assert.equal(await evaluate('[...document.querySelectorAll(".direction-map-arrow")].every((arrow)=>/^rotate\\(-?[0-9.]+deg\\)$/.test(arrow.style.transform))'), true)
    assert.equal(await evaluate('window.__BUS_TRACKER_MAP_METRICS__?.counters.polylineCreated-window.__BUS_TRACKER_MAP_METRICS__?.counters.polylineRemoved'), 1)
    assert.equal(await evaluate('document.querySelectorAll(".route-direction-arrow,.section-bus-icon").length'), 0)
    assert.equal(await evaluate('document.querySelectorAll(".direction-choice").length'), 2,
      'nearby position uses the same direction chooser as any other position')
    await send('Input.dispatchMouseEvent', { type: 'mouseWheel', x: 900, y: 485, deltaX: 0, deltaY: -320 })
    await delay(650)
    assert.ok(await evaluate('document.querySelectorAll(".direction-map-pin").length') <= 2, 'zoom does not duplicate guides')
    await send('Input.dispatchMouseEvent', { type: 'mouseWheel', x: 900, y: 485, deltaX: 0, deltaY: 320 })
    await delay(700)
    await until('document.querySelectorAll(".direction-map-pin").length===2', 'direction guides restored after zoom')
    const afterZoomGuides = await guideVisibility()
    assert.ok(afterZoomGuides.every((guide) => guide.inside && guide.clear), `guides stay visible after zoom: ${JSON.stringify(afterZoomGuides)}`)
    for (const width of [390, 320]) {
      await send('Emulation.setDeviceMetricsOverride', { width, height: 844, deviceScaleFactor: 1, mobile: true })
      await delay(650)
      assert.equal(await evaluate('(() => {const r=document.querySelector(".direction-chooser").getBoundingClientRect();return r.left>=0&&r.right<=innerWidth})()'), true)
      assert.ok(await evaluate('document.querySelectorAll(".direction-map-pin").length') <= 2)
      assert.ok((await guideVisibility()).every((guide) => guide.inside && guide.clear), `${width}px guide clearance`)
    }
    await send('Emulation.setDeviceMetricsOverride', { width: 1440, height: 900, deviceScaleFactor: 1, mobile: false })
    await until('document.querySelectorAll(".direction-map-pin").length===2', 'desktop guides after mobile resize')
    await delay(500)
    nearChooserPath = join(tmpdir(), `bustracker-route-11-stop-${focusSequence}-near-chooser.png`)
    writeFileSync(nearChooserPath, Buffer.from((await send('Page.captureScreenshot', { format: 'png' })).data, 'base64'))
  } else {
    assert.equal(await evaluate('!!document.querySelector(".direction-chooser")'), true)
    await until('window.__BUS_TRACKER_MAP_METRICS__?.counters.polylineCreated-window.__BUS_TRACKER_MAP_METRICS__?.counters.polylineRemoved===1', 'full ordered-shape preview')
    await until('document.querySelectorAll(".direction-map-pin").length===2', 'two visible-range direction guides')
    assert.ok((await guideVisibility()).every((guide) => guide.inside && guide.clear), 'far-view guides remain visible outside the chooser')
    assert.equal(await evaluate('document.querySelectorAll(".route-direction-arrow,.section-bus-icon").length'), 0)
    farChooserPath = join(tmpdir(), `bustracker-route-11-stop-${focusSequence}-far-chooser.png`)
    writeFileSync(farChooserPath, Buffer.from((await send('Page.captureScreenshot', { format: 'png' })).data, 'base64'))
  }
  if (nearPosition) await evaluate(`document.querySelectorAll('.direction-map-pin')[${focusSequence <= 52 ? 0 : 1}].click()`)
  else await evaluate(`document.querySelectorAll('.direction-choice')[${focusSequence <= 52 ? 0 : 1}].click()`)
  assert.equal(await evaluate('document.querySelectorAll(".direction-map-pin").length'), 0, 'selection clears map direction guides')
  const firstSections = focusSequence <= 52 ? 2 : 5
  const secondSections = firstSections - 1
  await until(`document.querySelectorAll('.route-stop-vehicles').length===${firstSections}`, 'first selected-direction sections')
  const activeLines = '(() => {const c=window.__BUS_TRACKER_MAP_METRICS__?.counters;return c ? c.polylineCreated-c.polylineRemoved : -1})()'
  assert.equal(await evaluate(`document.querySelector('.vehicle-group-heading')?.textContent?.includes('${firstSections}대')`), true)
  assert.equal(await evaluate(activeLines), firstSections * 2 + 1)
  if (nearPosition) {
    await evaluate('document.querySelector(".direction-reselect").click()')
    await until('document.querySelectorAll(".direction-map-pin").length===2', 'reselect restores direction guides')
    assert.equal(await evaluate(activeLines), 1, 'reselect keeps one preview line')
    assert.equal(await evaluate('document.querySelectorAll(".route-stop-vehicles").length'), 0)
    await evaluate(`document.querySelectorAll('.direction-map-pin')[${focusSequence <= 52 ? 0 : 1}].click()`)
    await until(`document.querySelectorAll('.route-stop-vehicles').length===${firstSections}`, 'reselected direction restores sections')
    assert.equal(requests.length, 1, 'direction reselect reuses the latest vehicle response')
  }
  await evaluate(`(() => { const row = [...document.querySelectorAll('.route-stop-row')]
    .find((item) => item.getAttribute('data-route-stop')?.includes(':${focusSequence}:'));
    if (!row) throw Error('Focus stop not rendered'); row.click() })()`)
  await delay(350)
  const overview = await send('Page.captureScreenshot', { format: 'png' })
  const overviewPath = join(tmpdir(), `bustracker-route-11-stop-${focusSequence}-overview.png`)
  writeFileSync(overviewPath, Buffer.from(overview.data, 'base64'))
  await send('Input.dispatchMouseEvent', { type: 'mouseWheel', x: 935, y: 475, deltaX: 0, deltaY: -420 })
  await send('Input.dispatchMouseEvent', { type: 'mouseWheel', x: 935, y: 475, deltaX: 0, deltaY: -420 })
  await delay(700)
  assert.equal(await evaluate(activeLines), firstSections * 2 + 1, 'zoom in keeps only selected-direction sections')
  await evaluate('document.querySelectorAll(".route-direction-arrow").forEach((arrow)=>arrow.style.display="none")')
  const focusedShape = await send('Page.captureScreenshot', { format: 'png' })
  const focusedShapePath = join(tmpdir(), `bustracker-route-11-stop-${focusSequence}-map.png`)
  writeFileSync(focusedShapePath, Buffer.from(focusedShape.data, 'base64'))
  await evaluate('document.querySelectorAll(".route-direction-arrow").forEach((arrow)=>arrow.style.display="")')
  await send('Input.dispatchMouseEvent', { type: 'mouseWheel', x: 935, y: 475, deltaX: 0, deltaY: 420 })
  await send('Input.dispatchMouseEvent', { type: 'mouseWheel', x: 935, y: 475, deltaX: 0, deltaY: 420 })
  await delay(700)
  assert.equal(await evaluate(activeLines), firstSections * 2 + 1, 'zoom out keeps only selected-direction sections')
  await delay(11_000)
  assert.equal(requests.length, 1, 'no automatic request should start about ten seconds after selection')
  assert.equal(await evaluate('document.querySelectorAll(".route-stop-vehicles").length'), firstSections)
  assert.equal(await evaluate(activeLines), firstSections * 2 + 1)
  phase = 'second'
  await evaluate('window.__actualNow=Date.now; Date.now=()=>window.__actualNow()+11000; document.querySelector(".vehicle-refresh").click()')
  await delay(150)
  assert.equal(await evaluate('document.querySelectorAll(".route-stop-vehicles").length'), firstSections)
  assert.equal(await evaluate(activeLines), firstSections * 2 + 1)
  await until(`document.querySelectorAll('.route-stop-vehicles').length===${secondSections}`, 'new selected-direction sections')
  assert.equal(await evaluate(activeLines), secondSections * 2 + 1)
  assert.equal(await evaluate('window.__sectionDrops.length'), nearPosition ? 1 : 0,
    `section drops: ${JSON.stringify(await evaluate('window.__sectionDrops.map(({reason,before,after})=>({reason,before,after}))'))}`)
  const screenshot = await send('Page.captureScreenshot', { format: 'png' })
  const screenshotPath = join(tmpdir(), 'bustracker-operational-sanitized-after-200.png')
  writeFileSync(screenshotPath, Buffer.from(screenshot.data, 'base64'))
  for (const ageMs of [6_000, 60_000, 119_000, 120_000]) {
    await evaluate(`Date.now=()=>${secondQueryAtMs}+${ageMs}; window.dispatchEvent(new Event('online'))`)
    await until(`document.querySelectorAll('.route-stop-vehicles').length===${secondSections}`, `fresh age ${ageMs}`)
    assert.equal(await evaluate(activeLines), secondSections * 2 + 1)
    assert.equal(await evaluate('window.__sectionDrops.length'), nearPosition ? 1 : 0,
      `age ${ageMs} section drops: ${JSON.stringify(await evaluate('window.__sectionDrops.map(({reason,before,after})=>({reason,before,after}))'))}`)
  }
  await evaluate(`Date.now=()=>${secondQueryAtMs}+120001; window.dispatchEvent(new Event('online'))`)
  await until('document.querySelectorAll(".route-stop-vehicles").length===0', '120-second expiry')
  assert.equal(await evaluate(activeLines), 1)
  assert.equal(await evaluate('window.__sectionDrops.at(-1)?.reason'), 'expired_query_time')
  assert.equal(await evaluate('window.__sectionDrops.at(-1)?.geometryMatched'), 6)
  assert.equal(requests.length, 2)
  assert.deepEqual(requests.map((request) => request.status), [200, 200])
  if (nearPosition) {
    await evaluate('document.querySelector(".direction-reselect").click()')
    await until('document.querySelectorAll(".direction-map-pin").length===2', 'guides return before deletion')
    await evaluate('document.querySelector(".route-remove").click()')
    await until('document.querySelectorAll(".direction-map-pin,.selected-route").length===0', 'deletion clears guides and route')
  }
  assert.equal(exceptions.length, 0, `Browser exceptions: ${exceptions.join(', ')}`)
  process.stdout.write(JSON.stringify({ fixture: 'sanitized single production snapshot', shapePoints: fixture.shape.shape.points.length,
    stopCount: stops.length, first: { vehicles: 19, verified: 7, rendered: firstSections },
    second: { vehicles: 18, verified: 6, rendered: secondSections }, freshAgesSec: [6, 60, 119, 120],
    expiredAgeMs: 120001, expiryReason: 'expired_query_time', requests,
    sectionDropLogs: await evaluate('window.__sectionDrops.length'), screenshot: screenshotPath,
    focusedShapeScreenshot: focusedShapePath, overviewScreenshot: overviewPath,
    nearChooserScreenshot: nearChooserPath, farChooserScreenshot: farChooserPath }) + '\n')
} finally {
  socket?.close()
  chrome?.kill()
  await server.close()
}
