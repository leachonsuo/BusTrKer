// Real Kakao map and Chrome UI, with saved sanitized GBIS fixtures served locally.
// No public-data API, Firebase deployment, or operational secret is used.
import { createServer } from 'vite'
import react from '@vitejs/plugin-react'
import { spawn } from 'node:child_process'
import { readFileSync, mkdtempSync, writeFileSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import assert from 'node:assert/strict'

const specs = [
  ['11', '219000001', 'goyang-11-sanitized', [52, 53], [2, 5]],
  ['30', '229000010', 'goyang-30-sanitized', [123, 123], [1, 1]],
  ['036', '241293003', 'gbis-241293003-sanitized', [35, 35], [0, 0]],
  ['799', '229000071', 'gbis-229000071-sanitized', null, null],
]
const routes = specs.map(([name, id, file, directionCounts, sectionCounts]) => {
  const fixture = JSON.parse(readFileSync(new URL(`./fixtures/${file}.json`, import.meta.url), 'utf8'))
  const first = fixture.stops.stops[0], last = fixture.stops.stops.at(-1)
  const route = fixture.detail?.route ?? { id: fixture.shape.shape.routeId, name, startName: first.name,
    endName: last.name, typeName: null, regionName: '고양시', startStopId: first.id, endStopId: last.id }
  return { name, id, directionCounts, sectionCounts, fixture, route }
})
const counts = new Map()
const now = () => new Date().toISOString()
const vehicle = (item, sequence) => ({ kind: 'stop-progress', routeId: item.route.id,
  vehicleId: String(900000 + sequence), stationSequence: sequence, stateCode: 2,
  currentStopId: item.fixture.stops.stops[sequence - 1].id,
  nextStopId: item.fixture.stops.stops[sequence].id, sectionVerified: true, observedAt: null })
const response = (path, query) => {
  if (path === '/api/stops/nearby') return { stops: [], queriedAt: now(), source: 'gbis' }
  if (path === '/api/routes/search') return { routes: routes.filter((item) => item.name.includes(query)).map((item) => item.route),
    queriedAt: now(), source: 'gbis' }
  for (const item of routes) {
    if (path === `/api/routes/${item.id}`) return { route: item.route, queriedAt: now(), source: 'gbis' }
    if (path === `/api/routes/${item.id}/shape`) return { ...item.fixture.shape, queriedAt: now() }
    if (path === `/api/routes/${item.id}/stops`) return { ...item.fixture.stops, queriedAt: now() }
    if (path === `/api/routes/${item.id}/vehicles`) return { routeId: item.route.id,
      vehicles: item.id === '219000001' ? item.fixture.vehicles.vehicles :
        item.id === '229000010' ? [vehicle(item, 30), vehicle(item, 129)] : [],
      queriedAt: now(), source: 'gbis' }
  }
  return null
}
const server = await createServer({ configFile: false, plugins: [react(), { name: 'saved-gbis-four-routes',
  configureServer(vite) { vite.middlewares.use('/api', (request, reply) => {
    const url = new URL(request.url ?? '', 'http://localhost')
    const path = `/api${url.pathname}`
    counts.set(path, (counts.get(path) ?? 0) + 1)
    const body = response(path, url.searchParams.get('q') ?? '')
    reply.writeHead(body ? 200 : 404, { 'Content-Type': 'application/json; charset=utf-8', 'Cache-Control': 'no-store' })
    reply.end(JSON.stringify(body ?? { error: 'NOT_FOUND', message: 'No fixture' }))
  }) },
}], server: { host: '127.0.0.1', port: 5173, strictPort: true } })
const delay = (ms) => new Promise((resolve) => setTimeout(resolve, ms))
const profile = mkdtempSync(join(tmpdir(), 'bustracker-four-routes-'))
const port = 12000 + Math.floor(Math.random() * 10000)
let chrome, socket
try {
  await server.listen()
  chrome = spawn('C:\\Program Files\\Google\\Chrome\\Application\\chrome.exe',
    ['--headless=new', '--no-first-run', '--no-default-browser-check', '--disable-gpu',
      '--host-resolver-rules=MAP localhost 127.0.0.1', `--remote-debugging-port=${port}`,
      `--user-data-dir=${profile}`, '--window-size=1440,900', 'about:blank'], { windowsHide: true, stdio: 'ignore' })
  let page
  for (let attempt = 0; attempt < 60; attempt++) {
    try { page = (await fetch(`http://127.0.0.1:${port}/json/list`).then((reply) => reply.json())).find((tab) => tab.type === 'page') }
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
    const id = ++serial
    pending.set(id, (message) => message.error ? reject(new Error(message.error.message)) : resolve(message.result))
    socket.send(JSON.stringify({ id, method, params }))
  })
  const evaluate = async (expression) => {
    const result = await send('Runtime.evaluate', { expression, returnByValue: true, awaitPromise: true })
    if (result.exceptionDetails) throw new Error(`Browser evaluation failed: ${expression.slice(0, 80)}`)
    return result.result.value
  }
  const until = async (expression, label) => {
    for (let attempt = 0; attempt < 100; attempt++) { if (await evaluate(expression)) return; await delay(250) }
    throw new Error(`${label} timed out`)
  }
  await send('Page.enable'); await send('Runtime.enable')
  await send('Page.navigate', { url: 'http://localhost:5173/' })
  await until('!!document.querySelector(".search-mode-switch")', 'app shell')
  await evaluate('document.querySelectorAll(".search-mode-switch button")[1].click()')
  const report = []
  const lineCount = () => evaluate('(() => {const c=window.__BUS_TRACKER_MAP_METRICS__?.counters;return c?c.polylineCreated-c.polylineRemoved:-1})()')
  for (const item of routes) {
    await evaluate(`(() => {const input=document.querySelector('[aria-label="버스번호 검색"]');
      const setter=Object.getOwnPropertyDescriptor(HTMLInputElement.prototype,'value').set;
      setter.call(input,${JSON.stringify(item.name)});input.dispatchEvent(new Event('input',{bubbles:true}))})()`)
    await until(`!!document.querySelector('.route-result')?.textContent?.includes('노선 ID ${item.id}')`, `${item.name} search`)
    await evaluate('document.querySelector(".route-result").click()')
    await until(`!!document.querySelector('.selected-route[data-route-key="gbis:gyeonggi:${item.id}"]')`, `${item.name} selected`)
    await until(`document.querySelector('.selected-route[data-route-key="gbis:gyeonggi:${item.id}"] .route-status')?.textContent?.includes('실제 형상')`, `${item.name} fixture loaded`)
    assert.equal(counts.get(`/api/routes/${item.id}/vehicles`) ?? 0, 0, 'preview cannot poll vehicles')
    await until('document.querySelectorAll(".direction-choice").length===2 || document.querySelector(".direction-chooser")?.textContent?.includes("전체 노선 개요만")', `${item.name} chooser`)
    await until('(window.__BUS_TRACKER_MAP_METRICS__?.counters.polylineCreated-window.__BUS_TRACKER_MAP_METRICS__?.counters.polylineRemoved)===1', `${item.name} preview line`)
    assert.equal(await evaluate('document.querySelectorAll(".section-bus-icon,.route-stop-vehicles").length'), 0)
    const guideCount = await evaluate('document.querySelectorAll(".direction-map-pin").length')
    if (!item.directionCounts) {
      assert.equal(await evaluate('document.querySelectorAll(".direction-choice,.direction-map-pin,.route-direction-arrow").length'), 0)
      assert.equal(await evaluate('document.querySelectorAll(".route-stop-row").length'), 149)
      assert.equal(await evaluate('document.querySelector(".selected-route .route-status")?.textContent?.includes("전체 노선 개요")'), true)
      assert.equal(counts.get(`/api/routes/${item.id}/vehicles`) ?? 0, 0)
      await evaluate('document.querySelector(".selected-route .selected-route-top button:nth-last-child(2)").click()')
      await evaluate('document.querySelectorAll(".route-color-preset")[4].click()')
      await until('getComputedStyle(document.querySelector(".route-color-dot")).backgroundColor==="rgb(209, 61, 69)"', 'fallback overview color updated')
      assert.equal(await lineCount(), 1)
      assert.equal(counts.get(`/api/routes/${item.id}/vehicles`) ?? 0, 0)
    } else {
      assert.equal(await evaluate('document.querySelectorAll(".direction-choice").length'), 2)
      assert.equal(await evaluate('document.querySelectorAll(".route-stop-row,.route-direction-arrow").length'), 0)
      for (let directionIndex = 0; directionIndex < 2; directionIndex++) {
        await evaluate(`document.querySelectorAll('.direction-choice')[${directionIndex}].click()`)
        await until(`document.querySelectorAll('.route-stop-row').length===${item.directionCounts[directionIndex]}`, `${item.name} direction ${directionIndex} stops`)
        await until('document.querySelectorAll(".direction-map-pin").length===0', `${item.name} guides removed`)
        await until(`document.querySelector('.selected-route .vehicle-group-heading')!==null`, `${item.name} vehicle panel`)
        await until(`document.querySelectorAll('.route-stop-vehicles').length===${item.sectionCounts[directionIndex]}`, `${item.name} direction ${directionIndex} verified sections`)
        assert.equal(await lineCount(), 1 + item.sectionCounts[directionIndex] * 2, 'base shape and only verified sections are drawn')
        assert.equal(counts.get(`/api/routes/${item.id}/vehicles`), 1, 'direction switch reuses route snapshot')
        assert.equal(await evaluate('document.querySelector(".selected-route .route-status")?.textContent?.includes("미리보기")'), false)
        if (directionIndex === 0) {
          await evaluate('document.querySelector(".direction-reselect").click()')
          await until('document.querySelectorAll(".direction-choice").length===2', `${item.name} reselect`)
          assert.equal(await lineCount(), 1, 'reselect shows only one preview line')
          assert.equal(await evaluate('document.querySelectorAll(".route-stop-vehicles").length'), 0)
          assert.equal(counts.get(`/api/routes/${item.id}/vehicles`), 1)
        }
      }
      const prior = counts.get(`/api/routes/${item.id}/vehicles`)
      const priorSections = await evaluate('document.querySelectorAll(".route-stop-vehicles").length')
      await evaluate('document.querySelector(".selected-route .selected-route-top button:nth-last-child(2)").click()')
      await evaluate('document.querySelectorAll(".route-color-preset")[1].click()')
      await until('getComputedStyle(document.querySelector(".legend-section")).borderTopColor==="rgb(197, 28, 181)"', `${item.name} section contrast updates`)
      assert.equal(await evaluate('getComputedStyle(document.querySelector(".legend-route")).borderTopColor'), 'rgb(33, 135, 91)')
      assert.equal(await evaluate('document.querySelectorAll(".route-stop-vehicles").length'), priorSections)
      await evaluate('document.querySelector(".route-color-reset").click()')
      await until('getComputedStyle(document.querySelector(".legend-route")).borderTopColor==="rgb(23, 105, 207)"', `${item.name} default color restored`)
      assert.equal(counts.get(`/api/routes/${item.id}/vehicles`), prior)
      if (item.id === '241293003') assert.equal(await evaluate('document.querySelector(".vehicle-group-heading")?.textContent?.includes("0대")'), true)
    }
    const screenshot = join(tmpdir(), `bustracker-four-routes-${item.name}.png`)
    writeFileSync(screenshot, Buffer.from((await send('Page.captureScreenshot', { format: 'png' })).data, 'base64'))
    if (item.id === '229000071') {
      await evaluate('document.querySelector(".route-stop-row").click()')
      await until('!!document.querySelector(".route-stop-row.selected")', '799 fallback stop focus')
      assert.equal(counts.get(`/api/routes/${item.id}/vehicles`) ?? 0, 0)
    }
    report.push({ route: item.name, directionChoices: item.directionCounts ? 2 : 0,
      guideCountBeforeSelection: guideCount, vehicleRequests: counts.get(`/api/routes/${item.id}/vehicles`) ?? 0,
      detailRequests: [counts.get(`/api/routes/${item.id}`), counts.get(`/api/routes/${item.id}/shape`), counts.get(`/api/routes/${item.id}/stops`)],
      screenshot })
    await evaluate('document.querySelector(".selected-route .route-remove").click()')
    await until('document.querySelectorAll(".selected-route").length===0', `${item.name} removed`)
    assert.equal(await lineCount(), 0)
  }
  assert.deepEqual(exceptions, [])
  process.stdout.write(JSON.stringify({ map: 'real Kakao SDK in Chrome', transit: 'sanitized local fixtures', report }) + '\n')
} finally {
  socket?.close()
  chrome?.kill()
  await server.close()
}
