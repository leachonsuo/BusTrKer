// Optional local UI smoke test. Requires a headless Chrome DevTools endpoint on port 9223.
const { writeFileSync } = require('node:fs')
const { tmpdir } = require('node:os')
const { join } = require('node:path')

const delay = (ms) => new Promise((resolve) => setTimeout(resolve, ms))

async function main() {
  let stage = 'connect'
  const pages = await fetch('http://127.0.0.1:9223/json/list').then((response) => response.json())
  const page = pages.find((item) => item.type === 'page')
  if (!page) throw new Error('Chrome page unavailable')
  const socket = new WebSocket(page.webSocketDebuggerUrl)
  const pending = new Map()
  let serial = 0
  let browserExceptions = 0
  const exceptionKinds = []
  let routeRequests = 0
  socket.onmessage = ({ data }) => {
    const message = JSON.parse(data)
    if (message.method === 'Runtime.exceptionThrown') {
      browserExceptions++
      exceptionKinds.push(String(message.params.exceptionDetails.exception?.description ?? message.params.exceptionDetails.text).split('\n')[0].slice(0, 140))
    }
    if (message.method === 'Network.requestWillBeSent' && /^\/api\/routes(?:\/|$)/.test(new URL(message.params.request.url).pathname) &&
      !new URL(message.params.request.url).pathname.endsWith('/vehicles')) routeRequests++
    if (!message.id) return
    const resolver = pending.get(message.id)
    pending.delete(message.id)
    resolver?.(message)
  }
  await new Promise((resolve, reject) => { socket.onopen = resolve; socket.onerror = reject })
  const send = (method, params = {}) => new Promise((resolve, reject) => {
    const id = ++serial
    pending.set(id, (message) => message.error ? reject(new Error(message.error.message)) : resolve(message.result))
    socket.send(JSON.stringify({ id, method, params }))
  })
  const evaluate = async (expression) => {
    const result = await send('Runtime.evaluate', { expression, returnByValue: true, awaitPromise: true })
    if (result.exceptionDetails) throw new Error('Browser evaluation failed')
    return result.result.value
  }
  const until = async (expression, label) => {
    for (let retry = 0; retry < 50; retry++) {
      if (await evaluate(expression)) return
      await delay(250)
    }
    throw new Error(`${label} timed out`)
  }
  const screenshot = async (name) => {
    const result = await send('Page.captureScreenshot', { format: 'png', captureBeyondViewport: false })
    const path = join(tmpdir(), name)
    writeFileSync(path, Buffer.from(result.data, 'base64'))
    return path
  }
  try {
    stage = 'navigate'
    await send('Page.enable')
    await send('Runtime.enable')
    await send('Network.enable')
    await send('Emulation.setDeviceMetricsOverride', { width: 1440, height: 900, deviceScaleFactor: 1, mobile: false })
    await send('Page.navigate', { url: 'http://localhost:5173/' })
    await until('!!(document.querySelector(".map-canvas") && document.querySelector(".stop-row"))', 'nearby stops')
    stage = 'search'
    await evaluate('document.querySelector(".search-mode-switch button:last-child").click()')
    await evaluate('(() => { const input=document.querySelector(".top-search input"); const setter=Object.getOwnPropertyDescriptor(HTMLInputElement.prototype,"value").set; setter.call(input,"11"); input.dispatchEvent(new Event("input",{bubbles:true})); return true })()')
    await until('document.querySelectorAll(".route-result").length >= 2', 'route search')
    stage = 'first-route'
    await evaluate('document.querySelectorAll(".route-result")[0].click()')
    await until('document.querySelector(".selected-route .route-status")?.textContent?.includes("노선형상")', 'route shape')
    await until('document.querySelectorAll(".route-direction-arrow").length > 0', 'direction arrows')
    const oneRoute = await evaluate('({ selected:document.querySelectorAll(".selected-route").length, arrows:document.querySelectorAll(".route-direction-arrow").length, shape:document.querySelector(".selected-route .route-status")?.textContent })')
    const desktopScreenshot = await screenshot('bustracker-route-desktop.png')
    if (!await evaluate('!!document.querySelector(".map-legend")')) throw new Error('Map legend is missing')
    await until('!!document.querySelector(".vehicle-list-toggle") || !!document.querySelector(".vehicle-group .route-error") || document.querySelector(".vehicle-group-heading strong")?.textContent?.includes("0대")', 'vehicle state')
    await evaluate('document.querySelector(".desktop-sidebar-toggle").click()')
    if (!await evaluate('document.querySelector(".sidebar").getBoundingClientRect().width === 0')) throw new Error('Desktop sidebar did not collapse')
    await evaluate('document.querySelector(".desktop-sidebar-toggle").click()')
    if (await evaluate('!!document.querySelector(".vehicle-list-toggle")')) {
      await evaluate('document.querySelector(".vehicle-list-toggle").click()')
      if (!await evaluate('document.querySelector(".vehicle-list").hidden')) throw new Error('Vehicle list did not collapse')
      await evaluate('document.querySelector(".vehicle-list-toggle").click()')
    }
    await send('Input.dispatchMouseEvent', { type: 'mouseWheel', x: 900, y: 500, deltaX: 0, deltaY: -350 })
    await delay(900)
    const zoomArrows = await evaluate('document.querySelectorAll(".route-direction-arrow").length')
    if (zoomArrows === 0) throw new Error('Direction arrows disappeared after zoom')
    await evaluate('document.querySelector(".map-fit-routes-button").click()')
    await until('document.querySelectorAll(".route-direction-arrow").length > 0', 'fitted route arrows')
    await delay(500)
    const activeMapObjects = '(() => {const c=window.__BUS_TRACKER_MAP_METRICS__?.counters;return c ? {maps:c.mapCreated-c.mapDisposed,polylines:c.polylineCreated-c.polylineRemoved,overlays:c.overlayCreated-c.overlayRemoved,listeners:c.listenerAdded-c.listenerRemoved} : null})()'
    const firstKey = await evaluate('document.querySelector(".selected-route").dataset.routeKey')
    const requestsBeforeToggle = routeRequests
    await evaluate('document.querySelector(".selected-route .route-action").click()')
    await until(`document.querySelectorAll('.route-direction-arrow[data-route-key="${firstKey}"]').length === 0`, 'hidden route arrows')
    const hiddenMapObjects = await evaluate(activeMapObjects)
    if (hiddenMapObjects && (hiddenMapObjects.polylines !== 0 || hiddenMapObjects.overlays !== 0)) {
      throw new Error(`Hidden route retained overlays: ${JSON.stringify(hiddenMapObjects)}`)
    }
    await evaluate('document.querySelector(".selected-route .route-action").click()')
    await until(`document.querySelectorAll('.route-direction-arrow[data-route-key="${firstKey}"]').length > 0`, 'restored route arrows').catch(async () => {
      await evaluate('document.querySelector(".map-fit-routes-button").click()')
      await until(`document.querySelectorAll('.route-direction-arrow[data-route-key="${firstKey}"]').length > 0`, 'restored route arrows after fit')
    })
    if (routeRequests !== requestsBeforeToggle) throw new Error('Visibility toggle fetched route data again')
    const afterVisibilityToggle = await evaluate(activeMapObjects)
    const documentVehicleLimit = await evaluate('document.querySelectorAll(".vehicle-row").length')
    if (afterVisibilityToggle && (afterVisibilityToggle.maps !== 1 || afterVisibilityToggle.polylines < 1 ||
      afterVisibilityToggle.polylines > 1 + documentVehicleLimit)) {
      throw new Error(`Map objects leaked across visibility toggle: ${JSON.stringify(afterVisibilityToggle)}`)
    }
    stage = 'second-route'
    await evaluate('document.querySelectorAll(".route-result")[1].click()')
    await until('document.querySelectorAll(".selected-route").length === 2', 'two selected routes')
    await until('document.querySelectorAll(".selected-route")[1]?.textContent?.includes("노선형상")', 'second route shape')
    const secondKey = await evaluate('document.querySelectorAll(".selected-route")[1].dataset.routeKey')
    await evaluate('document.querySelector(".map-fit-routes-button").click()')
    await until(`document.querySelectorAll('.route-direction-arrow[data-route-key="${firstKey}"]').length > 0 && document.querySelectorAll('.route-direction-arrow[data-route-key="${secondKey}"]').length > 0`, 'both route arrows')
    const colors = await evaluate('[...document.querySelectorAll(".selected-route .route-color-dot")].map((item)=>item.style.backgroundColor)')
    if (new Set(colors).size !== 2) throw new Error('Selected route colors overlap')
    await evaluate('document.querySelectorAll(".selected-route-name")[0].click()')
    const arrowCenter = await evaluate(`(() => {const r=document.querySelector('.route-direction-arrow[data-route-key="${secondKey}"]')?.getBoundingClientRect(); return r ? {x:r.left+r.width/2,y:r.top+r.height/2} : null})()`)
    if (arrowCenter) {
      await send('Input.dispatchMouseEvent', { type: 'mousePressed', x: arrowCenter.x, y: arrowCenter.y, button: 'left', clickCount: 1 })
      await send('Input.dispatchMouseEvent', { type: 'mouseReleased', x: arrowCenter.x, y: arrowCenter.y, button: 'left', clickCount: 1 })
      await until(`document.querySelectorAll('.selected-route')[1].classList.contains('active')`, 'map route selection').catch(async () => {
        const hit = await evaluate(`(() => {let e=document.elementFromPoint(${arrowCenter.x},${arrowCenter.y});const chain=[];for(let i=0;e&&i<5;i++,e=e.parentElement)chain.push({tag:e.tagName,className:e.getAttribute('class'),style:e.getAttribute('style')?.slice(0,100)});return {x:${arrowCenter.x},y:${arrowCenter.y},chain}})()`)
        throw new Error(`map route selection timed out: ${JSON.stringify(hit)}`)
      })
    }
    stage = 'five-routes'
    for (let index = 2; index < 5; index++) await evaluate(`document.querySelectorAll('.route-result')[${index}].click()`)
    await until('document.querySelectorAll(".selected-route").length === 5', 'five selected routes')
    await until('[...document.querySelectorAll(".selected-route")].every(x=>!x.textContent?.includes("도로 경로를 불러오는 중"))', 'five route shapes')
    await evaluate('document.querySelector(".map-fit-routes-button").click()')
    const fiveRoutes = await evaluate('({ selected:document.querySelectorAll(".selected-route").length, distinctColors:new Set([...document.querySelectorAll(".selected-route .route-color-dot")].map(x=>x.style.backgroundColor)).size, shapes:[...document.querySelectorAll(".selected-route")].filter(x=>x.textContent?.includes("실제 노선형상")).length, vehicles:document.querySelectorAll(".vehicle-row").length, activePolylines:(()=>{const c=window.__BUS_TRACKER_MAP_METRICS__?.counters;return c?c.polylineCreated-c.polylineRemoved:null})() })')
    if (fiveRoutes.distinctColors !== 5 || (fiveRoutes.activePolylines !== null && fiveRoutes.activePolylines > 5 + fiveRoutes.vehicles)) throw new Error('Five-route rendering mismatch')
    const fiveRouteScreenshot = await screenshot('bustracker-five-routes.png')
    await evaluate('document.querySelectorAll(".route-result")[5].click()')
    if (!await evaluate('document.querySelectorAll(".selected-route").length === 5 && !!document.querySelector(".selected-routes .route-error")')) throw new Error('Five-route limit was not enforced')
    for (let index = 4; index >= 2; index--) await evaluate(`document.querySelectorAll('.selected-route .route-remove')[${index}].click()`)
    await until('document.querySelectorAll(".selected-route").length === 2', 'five-route cleanup')
    stage = 'route-stops'
    await evaluate('document.querySelectorAll(".selected-route .route-remove")[1].click()')
    await until('document.querySelectorAll(".selected-route").length === 1', 'remove route')
    await evaluate('document.querySelector(".selected-route .route-expand").click()')
    await until('document.querySelectorAll(".selected-route .route-stop-row").length > 0', 'route stops')
    const stopRows = await evaluate('document.querySelectorAll(".selected-route .route-stop-row").length')
    await evaluate('document.querySelectorAll(".selected-route .route-stop-row")[0].click()')
    await until('!!document.querySelector(".arrival-panel")', 'arrival panel from route stop')
    stage = 'network-recovery'
    await send('Network.emulateNetworkConditions', { offline: true, latency: 0, downloadThroughput: 0, uploadThroughput: 0 })
    await until('document.querySelector(".arrival-error")?.textContent?.includes("네트워크 연결")', 'offline arrival state')
    await send('Network.emulateNetworkConditions', { offline: false, latency: 0, downloadThroughput: -1, uploadThroughput: -1 })
    await until('!!document.querySelector(".arrival-row") || document.querySelector(".arrival-message")?.textContent?.includes("제공되는 도착정보")', 'arrival recovery')
    await send('Emulation.setDeviceMetricsOverride', { width: 390, height: 844, deviceScaleFactor: 1, mobile: true })
    stage = 'mobile'
    await delay(800)
    await evaluate('document.querySelector(".arrival-heading button").click(); document.querySelector(".mobile-list-toggle").click()')
    const mobile = await evaluate('({ width:innerWidth, mapWidth:document.querySelector(".map-panel").getBoundingClientRect().width, panelHeight:document.querySelector(".sidebar").getBoundingClientRect().height, arrows:document.querySelectorAll(".route-direction-arrow").length })')
    const mobileScreenshot = await screenshot('bustracker-route-mobile.png')
    await evaluate('document.querySelector(".mobile-panel-size").click()')
    const expandedHeight = await evaluate('document.querySelector(".sidebar").getBoundingClientRect().height')
    if (expandedHeight <= mobile.panelHeight) throw new Error('Mobile panel did not expand')
    await send('Emulation.setDeviceMetricsOverride', { width: 320, height: 700, deviceScaleFactor: 1, mobile: true })
    await delay(350)
    const narrow = await evaluate('({ width:innerWidth, scrollWidth:document.documentElement.scrollWidth, mapWidth:document.querySelector(".map-panel").getBoundingClientRect().width, searchWidth:document.querySelector(".top-search input").getBoundingClientRect().width })')
    if (narrow.scrollWidth > narrow.width || narrow.searchWidth < 50) throw new Error('320px mobile layout overflows or search is inaccessible')
    const mapMetrics = await evaluate('(() => {const m=window.__BUS_TRACKER_MAP_METRICS__;if(!m)return null;const c=m.counters;const p95=a=>a.length?[...a].sort((x,y)=>x-y)[Math.ceil(a.length*.95)-1]:null;return {created:c.polylineCreated,removed:c.polylineRemoved,active:c.polylineCreated-c.polylineRemoved,overlaysCreated:c.overlayCreated,overlaysRemoved:c.overlayRemoved,activeOverlays:c.overlayCreated-c.overlayRemoved,activeListeners:c.listenerAdded-c.listenerRemoved,activeMaps:c.mapCreated-c.mapDisposed,routeUpdateP95Ms:p95(m.timings.routeUpdate),sectionUpdateP95Ms:p95(m.timings.sectionUpdate),arrowUpdateP95Ms:p95(m.timings.arrowUpdate)}})()')
    if (mapMetrics?.activeMaps !== 1 || mapMetrics.active < 0 || mapMetrics.activeOverlays < 0) throw new Error('Map object counters are inconsistent')
    process.stdout.write(JSON.stringify({ oneRoute, zoomArrows, colors, fiveRoutes, stopRows, mobile, expandedHeight, narrow, routeRequests, browserExceptions, exceptionKinds, mapMetrics, desktopScreenshot, fiveRouteScreenshot, mobileScreenshot }) + '\n')
    if (browserExceptions) throw new Error('Browser reported uncaught exceptions')
  } catch (error) {
    const state = stage === 'network-recovery' ? await evaluate('({online:navigator.onLine,state:document.querySelector(".arrival-error")?.textContent?.slice(0,100) ?? document.querySelector(".arrival-message")?.textContent?.slice(0,100) ?? document.querySelector(".arrival-row")?.textContent?.slice(0,100) ?? null})').catch(() => null) : null
    throw new Error(`${stage}: ${error.message}${state ? ` ${JSON.stringify(state)}` : ''}`)
  } finally {
    await send('Network.emulateNetworkConditions', { offline: false, latency: 0, downloadThroughput: -1, uploadThroughput: -1 }).catch(() => {})
    socket.close()
  }
}

main().catch((error) => { process.stdout.write(`UI QA failed: ${error.message}\n`); process.exitCode = 1 })
