// Local UI regression only. All /api responses below are fixtures, never GBIS data.
import { createServer } from 'vite'
import react from '@vitejs/plugin-react'
import { spawn } from 'node:child_process'
import { mkdtempSync, writeFileSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import assert from 'node:assert/strict'

const latlng = (latitude, longitude) => ({ latitude, longitude })
const id = (value) => ({ provider: 'gbis', regionCode: 'gyeonggi', value })
const points = [latlng(37.6584, 126.832), latlng(37.6587, 126.8325), latlng(37.659, 126.833),
  latlng(37.6593, 126.8335), latlng(37.6596, 126.834), latlng(37.6599, 126.8345), latlng(37.6602, 126.835)]
const stops = [
  { id: id('1001'), name: '시험 기점', position: points[0], mobileNo: '11111', distanceMeters: 0 },
  { id: id('1002'), name: '시험 중간', position: points[2], mobileNo: '22222', distanceMeters: 100 },
  { id: id('1003'), name: '시험 회차', position: points[4], mobileNo: '33333', distanceMeters: 200 },
  { id: id('1004'), name: '시험 종점', position: points[6], mobileNo: '44444', distanceMeters: 300 },
]
const route = { id: id('2001'), name: '시험 11', startName: '시험 기점', endName: '시험 종점', typeName: '일반',
  regionName: '고양시', startStopId: stops[0].id, endStopId: stops[3].id }
const routeStops = stops.map((stop, index) => ({ ...stop, distanceMeters: null, sequence: index + 1,
  turnYn: index === 2, turnSequence: index === 2 ? 3 : null }))
const secondPoints = points.map((point) => latlng(point.latitude, point.longitude + 0.02))
const secondRoute = { ...route, id: id('2002'), name: '시험 22', startStopId: id('3001'), endStopId: id('3004') }
const secondStops = routeStops.map((stop, index) => ({ ...stop, id: id(String(3001 + index)), position: secondPoints[index * 2] }))
const longPoints = Array.from({ length: 31 }, (_, index) => latlng(37.6584 + index * 0.0003, 126.832 + index * 0.00042))
const longRouteStops = longPoints.map((position, index) => ({ id: index === 0 ? stops[0].id : id(String(2000 + index)),
  name: `시험 정류장 ${index + 1}`, position, mobileNo: null, distanceMeters: null,
  sequence: index + 1, turnYn: index === 25, turnSequence: index === 25 ? 26 : null }))
const counts = new Map()
let vehicleFailure = false
let turnMissing = false
let deepRoute = false
// Synthetic counts for a refresh regression. The user's two live captures were 12m36s apart.
let vehiclePhase = 'single'
const payload = (path) => {
  const queriedAt = new Date().toISOString()
  const source = 'gbis'
  if (path === '/api/stops/nearby') return { stops, queriedAt, source }
  if (path === '/api/stops/1001/arrivals') return { arrivals: [{ routeId: route.id, stopId: stops[0].id,
    routeName: route.name, destination: '시험 종점', operationStatus: 'running', visits: [{ minutesUntilArrival: 4, stopsAway: 2 }] }], queriedAt, source }
  if (path === '/api/routes/search') return { routes: [route, secondRoute], queriedAt, source }
  if (path === '/api/routes/2001') return { route, queriedAt, source }
  if (path === '/api/routes/2001/shape') return { shape: { routeId: route.id, points: deepRoute ? longPoints : points }, queriedAt, source }
  if (path === '/api/routes/2001/stops') return { routeId: route.id,
    stops: turnMissing ? routeStops.map((stop) => ({ ...stop, turnYn: null, turnSequence: null })) : deepRoute ? longRouteStops : routeStops, queriedAt, source }
  if (path === '/api/routes/2002') return { route: secondRoute, queriedAt, source }
  if (path === '/api/routes/2002/shape') return { shape: { routeId: secondRoute.id, points: secondPoints }, queriedAt, source }
  if (path === '/api/routes/2002/stops') return { routeId: secondRoute.id, stops: secondStops, queriedAt, source }
  if (path === '/api/routes/2002/vehicles') return { routeId: secondRoute.id, vehicles: [], queriedAt, source }
  if (path === '/api/routes/2001/vehicles' && vehicleFailure) return { error: 'UPSTREAM_UNAVAILABLE', message: '모의 차량 조회 오류' }
  if (path === '/api/routes/2001/vehicles' && vehiclePhase !== 'single') {
    const verified = vehiclePhase === 'seven' ? 7 : 6
    const total = vehiclePhase === 'seven' ? 19 : 18
    return { routeId: route.id, vehicles: Array.from({ length: total }, (_, index) => {
      const sequence = index < verified ? index + 17 : 2
      return { kind: 'stop-progress', routeId: route.id, vehicleId: String(7001 + index), stationSequence: sequence,
        stateCode: index < verified ? 2 : 1, currentStopId: longRouteStops[sequence - 1].id,
        nextStopId: index < verified ? longRouteStops[sequence].id : null,
        sectionVerified: index < verified, observedAt: null }
    }), queriedAt, source }
  }
  if (path === '/api/routes/2001/vehicles') return { routeId: route.id, vehicles: [{ kind: 'stop-progress', routeId: route.id,
    vehicleId: '7001', stationSequence: deepRoute ? 20 : 1, stateCode: 2,
    currentStopId: deepRoute ? longRouteStops[19].id : stops[0].id,
    nextStopId: deepRoute ? longRouteStops[20].id : stops[1].id,
    sectionVerified: true, observedAt: null }], queriedAt, source }
  return null
}
const server = await createServer({ configFile: false, plugins: [react(), { name: 'local-transit-fixtures',
  configureServer(vite) { vite.middlewares.use('/api', (request, response) => {
    const path = `/api${new URL(request.url ?? '', 'http://localhost').pathname}`
    counts.set(path, (counts.get(path) ?? 0) + 1)
    const body = payload(path)
    response.writeHead(body ? vehicleFailure && path === '/api/routes/2001/vehicles' ? 503 : 200 : 404,
      { 'Content-Type': 'application/json; charset=utf-8' })
    const send = () => response.end(JSON.stringify(body ?? { error: 'NOT_FOUND', message: 'fixture missing' }))
    if (path === '/api/routes/2001/vehicles' && vehiclePhase === 'six') setTimeout(send, 600)
    else send()
  }) },
}], server: { host: '127.0.0.1', port: 5173, strictPort: true } })

const chromePath = 'C:\\Program Files\\Google\\Chrome\\Application\\chrome.exe'
const profile = mkdtempSync(join(tmpdir(), 'bustracker-ui-'))
const debugPort = 12000 + Math.floor(Math.random() * 10000)
let chrome
let socket
const delay = (ms) => new Promise((resolve) => setTimeout(resolve, ms))
try {
  await server.listen()
  chrome = spawn(chromePath, ['--headless=new', '--no-first-run', '--no-default-browser-check', '--disable-gpu',
    '--host-resolver-rules=MAP localhost 127.0.0.1',
    `--remote-debugging-port=${debugPort}`, `--user-data-dir=${profile}`, '--window-size=1440,900', 'about:blank'],
  { windowsHide: true, stdio: 'ignore' })
  let page
  for (let attempt = 0; attempt < 60; attempt++) {
    try { page = (await fetch(`http://127.0.0.1:${debugPort}/json/list`).then((res) => res.json())).find((tab) => tab.type === 'page') }
    catch { /* Chrome is starting. */ }
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
    const token = ++serial
    pending.set(token, (reply) => reply.error ? reject(new Error(reply.error.message)) : resolve(reply.result))
    socket.send(JSON.stringify({ id: token, method, params }))
  })
  const evaluate = async (expression) => {
    const result = await send('Runtime.evaluate', { expression, returnByValue: true, awaitPromise: true })
    if (result.exceptionDetails) throw new Error(`Browser evaluation failed: ${expression.slice(0, 70)}`)
    return result.result.value
  }
  const until = async (expression, label) => {
    for (let attempt = 0; attempt < 80; attempt++) {
      if (await evaluate(expression)) return
      await delay(250)
    }
    throw new Error(`${label} timed out`)
  }
  await send('Page.enable')
  await send('Runtime.enable')
  await send('Emulation.setDeviceMetricsOverride', { width: 1440, height: 900, deviceScaleFactor: 1, mobile: false })
  await send('Page.navigate', { url: 'http://localhost:5173/' })
  await until('!!document.querySelector(".stop-row")', 'nearby fixture stops')
  assert.equal(await evaluate('document.querySelector(".stop-row")?.textContent?.includes("시험 기점")'), true, 'fixture browser is attached')
  await evaluate('document.querySelector(".stop-row").click()')
  await until('!!document.querySelector(".arrival-row .route-number")', 'fixture arrival')
  await evaluate('document.querySelector(".arrival-row .route-number").click()')
  await until('document.querySelectorAll(".direction-choice").length===2', 'direction choices')
  assert.equal(counts.get('/api/routes/2001/vehicles') ?? 0, 0, 'direction chooser does not poll vehicles')
  assert.equal(await evaluate('document.querySelector(".direction-chooser:not(.is-nearby)")!==null'), true)
  assert.equal(await evaluate('document.querySelector(".direction-chooser")?.textContent?.includes("시험 회차 방면 경로를 미리 표시")'), true,
    await evaluate('document.querySelector(".direction-chooser")?.textContent'))
  await until('window.__BUS_TRACKER_MAP_METRICS__?.counters.polylineCreated-window.__BUS_TRACKER_MAP_METRICS__?.counters.polylineRemoved===1', 'far overview preview line')
  assert.equal(await evaluate('document.querySelectorAll(".route-direction-arrow").length'), 0, 'overview has no detailed direction arrows')
  assert.equal(await evaluate('document.querySelectorAll(".route-stop-row,.route-stop-vehicles").length'), 0)
  const firstShapeCalls = counts.get('/api/routes/2001/shape')
  const previewRemoved = await evaluate('window.__BUS_TRACKER_MAP_METRICS__.counters.polylineRemoved')
  await evaluate('document.querySelectorAll(".direction-choice")[0].click()')
  await until('!!document.querySelector(".route-stop-row")', 'route stops')
  assert.equal(await evaluate('document.querySelector(".search-mode-switch button.active")?.textContent'), '버스 노선')
  assert.equal(await evaluate('document.querySelectorAll(".route-stop-row").length'), 3)
  assert.equal(await evaluate('!!document.querySelector(".route-stop-row.turnaround")'), true)
  await until('!!document.querySelector(".route-stop-vehicles")', 'verified list section')
  await until('!!document.querySelector(".section-bus-icon")', 'verified map icon')
  assert.ok(await evaluate('window.__BUS_TRACKER_MAP_METRICS__.counters.polylineRemoved') > previewRemoved,
    'choosing a direction replaces the preview polyline')
  assert.equal(await evaluate('window.__BUS_TRACKER_MAP_METRICS__.counters.polylineCreated-window.__BUS_TRACKER_MAP_METRICS__.counters.polylineRemoved'), 3,
    'selected direction has one base line plus section color and halo')
  assert.equal(await evaluate('document.querySelector(".route-direction-arrow")?.textContent'), '›')
  assert.equal(await evaluate('getComputedStyle(document.querySelector(".legend-section")).borderTopColor'), 'rgb(236, 33, 131)', 'blue route has pink section')
  const colorChangeCalls = counts.get('/api/routes/2001/vehicles')
  await evaluate('document.querySelector(".selected-route .selected-route-top button:nth-last-child(2)").click()')
  await evaluate('document.querySelectorAll(".route-color-preset")[1].click()')
  await until('getComputedStyle(document.querySelector(".legend-section")).borderTopColor==="rgb(197, 28, 181)"', 'green route has magenta section')
  assert.equal(await evaluate('getComputedStyle(document.querySelector(".legend-route")).borderTopColor'), 'rgb(33, 135, 91)')
  assert.equal(await evaluate('getComputedStyle(document.querySelector(".section-bus-icon")).borderTopColor'), 'rgb(197, 28, 181)')
  assert.equal(await evaluate('getComputedStyle(document.querySelector(".route-stop-vehicles")).borderLeftColor'), 'rgb(197, 28, 181)')
  assert.equal(counts.get('/api/routes/2001/vehicles'), colorChangeCalls, 'color change makes no vehicle request')
  await evaluate('document.querySelectorAll(".route-color-preset")[0].click()')
  await until('getComputedStyle(document.querySelector(".legend-section")).borderTopColor==="rgb(236, 33, 131)"', 'blue section restored')
  await evaluate(`(() => {const input=document.querySelector('.route-color-picker input[type=color]');
    Object.getOwnPropertyDescriptor(HTMLInputElement.prototype,'value').set.call(input,'#e6b31b');
    input.dispatchEvent(new Event('input',{bubbles:true})); input.dispatchEvent(new Event('change',{bubbles:true}))})()`)
  await until('getComputedStyle(document.querySelector(".legend-section")).borderTopColor==="rgb(23, 105, 223)"', 'custom yellow route has blue section')
  assert.equal(await evaluate('getComputedStyle(document.querySelector(".legend-route")).borderTopColor'), 'rgb(230, 179, 27)')
  assert.equal(await evaluate('JSON.parse(localStorage.getItem("bustracker.route-colors.v1"))["gbis:gyeonggi:2001"]'), '#e6b31b')
  assert.equal(counts.get('/api/routes/2001/vehicles'), colorChangeCalls, 'custom color makes no vehicle request')
  await evaluate('document.querySelectorAll(".route-color-preset")[0].click()')
  await until('getComputedStyle(document.querySelector(".legend-section")).borderTopColor==="rgb(236, 33, 131)"', 'blue section restored after custom color')
  assert.equal(await evaluate('JSON.parse(localStorage.getItem("bustracker.route-colors.v1"))["gbis:gyeonggi:2001"]'), '#1769cf')
  const desktopScreenshot = await send('Page.captureScreenshot', { format: 'png' })
  const desktopPath = join(tmpdir(), 'bustracker-route-ui-mock-desktop.png')
  writeFileSync(desktopPath, Buffer.from(desktopScreenshot.data, 'base64'))
  await evaluate('document.querySelectorAll(".route-stop-row")[1].click()')
  assert.equal(await evaluate('document.querySelectorAll(".route-stop-row.selected").length'), 1)
  await delay(350)
  const markerCentered = await evaluate(`(() => {const marker=document.querySelector('img[src*="stop-pin-selected"]'); const map=document.querySelector('.map-canvas'); if(!marker||!map)return false; const a=marker.getBoundingClientRect(), b=map.getBoundingClientRect(); return Math.abs(a.left+a.width/2-b.left-b.width/2)<100 && Math.abs(a.top+a.height/2-b.top-b.height/2)<100})()`)
  assert.equal(markerCentered, true, 'selected route stop should move near map center')
  await evaluate('document.querySelector(".section-bus-icon").click()')
  await until('!!document.querySelector(".route-section-detail")', 'section explanation')
  const beforeSwitchCalls = counts.get('/api/routes/2001/vehicles')
  await evaluate('document.querySelector(".direction-reselect").click()')
  await until('document.querySelectorAll(".direction-choice").length===2', 'reselect direction')
  assert.equal(await evaluate('document.querySelectorAll(".route-stop-row,.route-stop-vehicles").length'), 0)
  await until('window.__BUS_TRACKER_MAP_METRICS__.counters.polylineCreated-window.__BUS_TRACKER_MAP_METRICS__.counters.polylineRemoved===1', 'preview restored on reselect')
  assert.equal(await evaluate('document.querySelectorAll(".route-direction-arrow,.section-bus-icon").length'), 0)
  assert.equal(counts.get('/api/routes/2001/shape'), firstShapeCalls, 'preview reuses the loaded GBIS shape')
  await evaluate('document.querySelectorAll(".direction-choice")[1].click()')
  await until('document.querySelectorAll(".route-stop-row").length===2', 'reverse direction stops')
  assert.equal(await evaluate('getComputedStyle(document.querySelector(".selected-route .route-color-dot")).backgroundColor'), 'rgb(23, 105, 207)', 'direction change keeps route color')
  assert.equal(await evaluate('document.querySelectorAll(".route-stop-vehicles").length'), 0)
  assert.equal(await evaluate('window.__BUS_TRACKER_MAP_METRICS__.counters.polylineCreated-window.__BUS_TRACKER_MAP_METRICS__.counters.polylineRemoved'), 1,
    'reverse direction replaces preview with only its base line')
  assert.equal(counts.get('/api/routes/2001/vehicles'), beforeSwitchCalls, 'direction switch reuses one route response')
  await evaluate('document.querySelector(".direction-reselect").click()')
  await until('document.querySelectorAll(".direction-choice").length===2', 'choose first direction again')
  await evaluate('document.querySelectorAll(".direction-choice")[0].click()')
  await until('document.querySelectorAll(".route-stop-row").length===3', 'restore first direction')
  const detailCalls = counts.get('/api/routes/2001')
  await evaluate('document.querySelector(".top-search input").focus()')
  await evaluate('(() => {const input=document.querySelector(".top-search input"); Object.getOwnPropertyDescriptor(HTMLInputElement.prototype,"value").set.call(input,"시험 11"); input.dispatchEvent(new Event("input",{bubbles:true}))})()')
  await until('!!document.querySelector(".route-result")', 'route search fixture')
  await evaluate('document.querySelector(".route-result").click()')
  assert.equal(await evaluate('document.querySelectorAll(".selected-route").length'), 1)
  assert.equal(counts.get('/api/routes/2001'), detailCalls, 'repeat selection must reuse route data')
  await until('document.querySelectorAll(".route-result").length===2', 'second route search result')
  await evaluate('document.querySelectorAll(".route-result")[1].click()')
  await until('document.querySelectorAll(".selected-route").length===2 && document.querySelectorAll(".direction-choice").length===2', 'second route preview')
  assert.equal(await evaluate('document.querySelector(".direction-chooser")?.textContent?.includes("시험 회차 방면 경로를 미리 표시")'), true)
  await until('window.__BUS_TRACKER_MAP_METRICS__.counters.polylineCreated-window.__BUS_TRACKER_MAP_METRICS__.counters.polylineRemoved===4', 'two route lines plus first route section and halo')
  assert.equal(counts.get('/api/routes/2002/vehicles') ?? 0, 0, 'second route preview does not poll vehicles')
  await evaluate('document.querySelectorAll(".selected-route")[1].querySelector(".route-action").click()')
  await until('window.__BUS_TRACKER_MAP_METRICS__.counters.polylineCreated-window.__BUS_TRACKER_MAP_METRICS__.counters.polylineRemoved===3', 'hiding preview removes only second route line')
  await evaluate('document.querySelectorAll(".selected-route")[1].querySelector(".route-action").click()')
  await until('document.querySelectorAll(".direction-choice").length===2 && window.__BUS_TRACKER_MAP_METRICS__.counters.polylineCreated-window.__BUS_TRACKER_MAP_METRICS__.counters.polylineRemoved===4', 'show second route preview again')
  const multiPreviewRemoved = await evaluate('window.__BUS_TRACKER_MAP_METRICS__.counters.polylineRemoved')
  await evaluate('document.querySelectorAll(".direction-choice")[0].click()')
  await until('document.querySelectorAll(".selected-route")[1]?.querySelectorAll(".route-stop-row").length===3', 'second route selected direction')
  assert.deepEqual(await evaluate('[...document.querySelectorAll(".selected-route .route-color-dot")].map((dot)=>getComputedStyle(dot).backgroundColor)'),
    ['rgb(23, 105, 207)', 'rgb(33, 135, 91)'], 'simultaneous routes retain independent base colors')
  assert.equal(await evaluate('getComputedStyle(document.querySelector(".legend-section")).borderTopColor'), 'rgb(197, 28, 181)', 'legend follows active route')
  assert.ok(await evaluate('window.__BUS_TRACKER_MAP_METRICS__.counters.polylineRemoved') > multiPreviewRemoved,
    'second route selected direction replaces its preview')
  assert.equal(await evaluate('document.querySelectorAll(".route-stop-vehicles").length'), 1, 'first route section remains')
  await evaluate('document.querySelectorAll(".direction-reselect")[1].click()')
  await until('document.querySelectorAll(".direction-choice").length===2 && window.__BUS_TRACKER_MAP_METRICS__.counters.polylineCreated-window.__BUS_TRACKER_MAP_METRICS__.counters.polylineRemoved===4', 'second route preview restored')
  await evaluate('document.querySelectorAll(".selected-route")[1].querySelector(".route-remove").click()')
  await until('document.querySelectorAll(".selected-route").length===1 && window.__BUS_TRACKER_MAP_METRICS__.counters.polylineCreated-window.__BUS_TRACKER_MAP_METRICS__.counters.polylineRemoved===3', 'second route preview deleted without touching first route')
  assert.equal(await evaluate('JSON.parse(localStorage.getItem("bustracker.route-colors.v1"))["gbis:gyeonggi:2002"]'), '#21875b', 'deleted route retains its color setting')
  deepRoute = true
  await send('Page.navigate', { url: 'http://localhost:5173/' })
  await until('!!document.querySelector(".stop-row")', 'deep route stop')
  await evaluate('document.querySelector(".stop-row").click()')
  await until('!!document.querySelector(".arrival-row .route-number")', 'deep route arrival')
  await evaluate('document.querySelector(".arrival-row .route-number").click()')
  await until('document.querySelectorAll(".direction-choice").length===2', 'deep direction choices')
  await evaluate('document.querySelectorAll(".direction-choice")[0].click()')
  await until('!!document.querySelector(".route-stop-vehicles")', 'deep verified section')
  await until(`(() => {const list=document.querySelector('.route-stop-list'), icon=list?.querySelector('.route-stop-vehicles'); if(!list||!icon)return false; const a=list.getBoundingClientRect(), b=icon.getBoundingClientRect(); return list.scrollTop>0 && b.top>=a.top && b.bottom<=a.bottom})()`, 'deep section visible in list')
  assert.equal(await evaluate('getComputedStyle(document.querySelector(".legend-section")).borderTopColor'), 'rgb(236, 33, 131)')
  const deepScreenshot = await send('Page.captureScreenshot', { format: 'png' })
  const deepPath = join(tmpdir(), 'bustracker-route-ui-mock-deep.png')
  writeFileSync(deepPath, Buffer.from(deepScreenshot.data, 'base64'))
  await evaluate('window.__originalDateNow=Date.now; Date.now=()=>window.__originalDateNow()+11000')
  vehiclePhase = 'seven'
  await evaluate('document.querySelector(".vehicle-refresh").click()')
  await until('document.querySelector(".vehicle-summary")?.textContent?.includes("7대") && document.querySelectorAll(".route-stop-vehicles").length===7', 'nineteen vehicles with seven sections')
  assert.equal(await evaluate('document.querySelector(".vehicle-group-heading")?.textContent?.includes("7대")'), true)
  const activePolylines = '(() => {const c=window.__BUS_TRACKER_MAP_METRICS__?.counters;return c ? c.polylineCreated-c.polylineRemoved : -1})()'
  assert.equal(await evaluate(activePolylines), 15, 'one base route and seven sections with halos')
  vehiclePhase = 'six'
  await evaluate('Date.now=()=>window.__originalDateNow()+22000; document.querySelector(".vehicle-refresh").click()')
  await delay(150)
  assert.equal(await evaluate('document.querySelectorAll(".route-stop-vehicles").length'), 7,
    'existing verified sections must remain visible during the next request')
  assert.equal(await evaluate(activePolylines), 15, 'map sections must remain while the next request is in flight')
  await until('document.querySelector(".vehicle-summary")?.textContent?.includes("6대") && document.querySelectorAll(".route-stop-vehicles").length===6', 'eighteen vehicles with six sections')
  assert.equal(await evaluate('document.querySelector(".vehicle-group-heading")?.textContent?.includes("6대")'), true)
  assert.equal(await evaluate('document.querySelectorAll(".route-stop-vehicles").length'), 6)
  assert.equal(await evaluate(activePolylines), 13, 'map must show the six sections and halos from the newest response')
  await send('Emulation.setDeviceMetricsOverride', { width: 390, height: 844, deviceScaleFactor: 1, mobile: true })
  await delay(500)
  assert.equal(await evaluate('document.querySelector(".mobile-list-toggle")?.getBoundingClientRect().height > 0'), true)
  assert.equal(await evaluate('document.querySelector(".sidebar")?.getBoundingClientRect().height > 0'), true)
  const screenshot = await send('Page.captureScreenshot', { format: 'png' })
  const screenshotPath = join(tmpdir(), 'bustracker-route-ui-mock-mobile.png')
  writeFileSync(screenshotPath, Buffer.from(screenshot.data, 'base64'))
  await evaluate('window.__dropLogs=[]; const originalInfo=console.info; console.info=(tag,detail)=>{if(tag==="BUS_TRACKER_SECTION_DROP") window.__dropLogs.push(detail); originalInfo(tag,detail)}')
  vehicleFailure = true
  await evaluate('Date.now=()=>window.__originalDateNow()+33000; document.querySelector(".vehicle-refresh").click()')
  await until('window.__dropLogs?.length===1', 'development-only section loss diagnosis')
  assert.equal(await evaluate('window.__dropLogs[0].reason'), 'request_error')
  assert.equal(await evaluate('window.__dropLogs[0].before.rendered'), 6)
  assert.equal(await evaluate('window.__dropLogs[0].after.rendered'), 0)
  assert.equal(await evaluate('window.__dropLogs[0].recentActions.at(-1)?.httpStatus'), 503)
  assert.equal(await evaluate('!/vehicleId|serviceKey|plate|coordinates|rawBody|requestUrl/i.test(JSON.stringify(window.__dropLogs[0]))'), true)
  turnMissing = true
  deepRoute = false
  vehiclePhase = 'single'
  await send('Page.navigate', { url: 'http://localhost:5173/' })
  await until('!!document.querySelector(".stop-row")', 'failure fixture stops')
  await evaluate('document.querySelector(".stop-row").click()')
  await until('!!document.querySelector(".arrival-row .route-number")', 'failure fixture arrival')
  await evaluate('document.querySelector(".arrival-row .route-number").click()')
  await until('document.querySelector(".direction-chooser")?.textContent?.includes("회차 정류장이 하나로 확인되지 않습니다.")', 'unavailable direction fallback')
  assert.equal(await evaluate('document.querySelectorAll(".direction-choice").length'), 0)
  assert.equal(await evaluate('document.querySelectorAll(".route-stop-row").length'), 4, 'fallback keeps all ordered stops')
  assert.equal(await evaluate('document.querySelectorAll(".section-bus-icon,.route-stop-vehicles").length'), 0)
  await until('window.__BUS_TRACKER_MAP_METRICS__.counters.polylineCreated-window.__BUS_TRACKER_MAP_METRICS__.counters.polylineRemoved===1', 'fallback full route overview')
  assert.equal(await evaluate('document.querySelectorAll(".route-direction-arrow").length'), 0)
  turnMissing = false
  vehicleFailure = false
  await send('Page.addScriptToEvaluateOnNewDocument', { source: `Object.defineProperty(navigator, 'geolocation', { configurable: true, value: {
    getCurrentPosition(success) { success({ coords: { latitude: 37.6584, longitude: 126.832, accuracy: 25 } }) }
  } })` })
  await send('Emulation.setDeviceMetricsOverride', { width: 1440, height: 900, deviceScaleFactor: 1, mobile: false })
  await send('Page.navigate', { url: 'http://localhost:5173/' })
  await until('!!document.querySelector(".stop-row")', 'near-location stops')
  await evaluate('document.querySelector(".stop-row").click()')
  await until('!!document.querySelector(".arrival-row .route-number")', 'near-location arrival')
  const beforeNearbyVehicles = counts.get('/api/routes/2001/vehicles')
  await evaluate('document.querySelector(".arrival-row .route-number").click()')
  await until('document.querySelectorAll(".direction-choice").length===2', 'near-location chooser')
  assert.equal(await evaluate('document.querySelector(".direction-chooser")?.textContent?.includes("시험 회차 방면 경로를 미리 표시")'), true)
  assert.equal(await evaluate('document.querySelectorAll(".direction-map-pin").length'), 0,
    'synthetic same-heading shape cannot safely place two distinct road-direction labels')
  assert.equal(await evaluate('window.__BUS_TRACKER_MAP_METRICS__?.counters.polylineCreated-window.__BUS_TRACKER_MAP_METRICS__?.counters.polylineRemoved'), 1,
    'nearby chooser draws one full ordered-shape preview')
  assert.equal(await evaluate('document.querySelectorAll(".route-direction-arrow,.section-bus-icon").length'), 0,
    'preview does not draw arrows or vehicle icons')
  assert.equal(await evaluate('document.querySelectorAll(".route-stop-row,.route-stop-vehicles").length'), 0)
  assert.equal(counts.get('/api/routes/2001/vehicles'), beforeNearbyVehicles, 'no vehicle poll before nearby direction selection')
  const nearScreenshot = await send('Page.captureScreenshot', { format: 'png' })
  const nearPath = join(tmpdir(), 'bustracker-route-ui-mock-near.png')
  writeFileSync(nearPath, Buffer.from(nearScreenshot.data, 'base64'))
  await send('Emulation.setDeviceMetricsOverride', { width: 320, height: 700, deviceScaleFactor: 1, mobile: true })
  await delay(400)
  assert.equal(await evaluate('(() => {const r=document.querySelector(".direction-chooser")?.getBoundingClientRect(); return !!r && r.left>=0 && r.right<=innerWidth && r.top>=0 && r.bottom<=innerHeight})()'), true,
    '320px direction chooser must fit viewport')
  const narrowScreenshot = await send('Page.captureScreenshot', { format: 'png' })
  const narrowPath = join(tmpdir(), 'bustracker-route-ui-mock-320.png')
  writeFileSync(narrowPath, Buffer.from(narrowScreenshot.data, 'base64'))
  await evaluate('document.querySelectorAll(".direction-choice")[0].click()')
  await until('document.querySelectorAll(".route-stop-row").length===3', 'nearby selected-direction stops')
  assert.equal(exceptions.length, 0, `Browser exceptions: ${exceptions.join(', ')}`)
  process.stdout.write(`Mock UI passed: far/near single-direction preview, direction replacement and reselect, two-route hide/show/delete, arrival → route/list, turn, verified section, map icon, stop focus, 19/7 → 18/6 refresh, mobile, missing turn, 320px. Screenshots: ${desktopPath}; ${deepPath}; ${screenshotPath}; ${nearPath}; ${narrowPath}\n`)
  process.stdout.write('Fixture responses only. No GBIS or Firebase API call was made.\n')
} finally {
  socket?.close()
  chrome?.kill()
  await server.close()
}
