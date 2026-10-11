// Local browser smoke test. Requires Chrome DevTools on 127.0.0.1:9223 and both local servers.
async function main() {
  const routeName = process.argv[2] ?? '9709N'
  const tabs = await fetch('http://127.0.0.1:9223/json/list').then((response) => response.json())
  const tab = tabs.find((item) => item.type === 'page')
  if (!tab) throw new Error('No Chrome tab')
  const socket = new WebSocket(tab.webSocketDebuggerUrl)
  const pending = new Map()
  let serial = 0, exceptions = 0, vehicleRequests = 0
  socket.onmessage = ({ data }) => {
    const message = JSON.parse(data)
    if (message.method === 'Runtime.exceptionThrown') exceptions++
    if (message.method === 'Network.requestWillBeSent' && /\/api\/routes\/\d+\/vehicles$/.test(new URL(message.params.request.url).pathname)) vehicleRequests++
    if (message.id) { pending.get(message.id)?.(message); pending.delete(message.id) }
  }
  await new Promise((resolve, reject) => { socket.onopen = resolve; socket.onerror = reject })
  const send = (method, params = {}) => new Promise((resolve, reject) => {
    const id = ++serial
    pending.set(id, (message) => message.error ? reject(new Error(message.error.message)) : resolve(message.result))
    socket.send(JSON.stringify({ id, method, params }))
  })
  const evalJs = async (expression) => {
    const reply = await send('Runtime.evaluate', { expression, returnByValue: true, awaitPromise: true })
    if (reply.exceptionDetails) throw new Error('Browser evaluation failed')
    return reply.result.value
  }
  const until = async (expression, label) => {
    for (let i = 0; i < 60; i++) {
      if (await evalJs(expression)) return
      await new Promise((resolve) => setTimeout(resolve, 250))
    }
    const state = await evalJs('({selected:document.querySelectorAll(".selected-route").length, vehicles:document.querySelectorAll(".vehicle-row").length, errors:[...document.querySelectorAll(".route-error,.list-error")].map(x=>x.textContent?.slice(0,100)), results:document.querySelectorAll(".route-result").length})')
    throw new Error(`${label} timed out: ${JSON.stringify(state)}`)
  }
  try {
    await send('Page.enable'); await send('Runtime.enable'); await send('Network.enable')
    await send('Emulation.setDeviceMetricsOverride', { width: 1440, height: 900, deviceScaleFactor: 1, mobile: false })
    await send('Page.navigate', { url: 'http://localhost:5173/' })
    await until('!!document.querySelector(".map-canvas")', 'map')
    await evalJs('document.querySelector(".search-mode-switch button:last-child").click()')
    await evalJs(`(() => {const input=document.querySelector(".top-search input"); Object.getOwnPropertyDescriptor(HTMLInputElement.prototype,"value").set.call(input,${JSON.stringify(routeName)}); input.dispatchEvent(new Event("input",{bubbles:true})); return true})()`)
    await until(`!![...document.querySelectorAll(".route-result")].find(x=>x.querySelector(".route-result-number")?.textContent===${JSON.stringify(routeName)})`, 'route search')
    await evalJs(`[...document.querySelectorAll(".route-result")].find(x=>x.querySelector(".route-result-number")?.textContent===${JSON.stringify(routeName)}).click()`)
    await until('document.querySelectorAll(".vehicle-row").length > 0 || !!document.querySelector(".vehicle-group .route-error") || document.querySelector(".vehicle-group-heading strong")?.textContent?.includes("0대")', 'vehicle result')
    await until('document.querySelector(".selected-route .route-status")?.textContent?.includes("노선형상") || !!document.querySelector(".selected-route>.route-error")', 'route shape result')
    const desktop = await evalJs('({ route:document.querySelector(".selected-route-name strong")?.textContent, vehicles:document.querySelectorAll(".vehicle-row").length, status:document.querySelector(".vehicle-group-heading")?.textContent, gpsLabel:[...document.querySelectorAll(".vehicle-row small")].some(x=>x.textContent?.includes("GPS 없음")), errorVisible:!!document.querySelector(".vehicle-group .route-error"), roadShape:!!document.querySelector(".selected-route .route-status")?.textContent?.includes("노선형상") })')
    if ((desktop.vehicles > 0 && !desktop.gpsLabel && !desktop.errorVisible) || !desktop.roadShape) throw new Error(`Vehicle or route state mismatch: ${JSON.stringify(desktop)}`)
    const sectionClickable = await evalJs('[...document.querySelectorAll(".vehicle-row")].some(x=>x.textContent?.includes("구간 기준 위치"))')
    if (sectionClickable) {
      await evalJs('[...document.querySelectorAll(".vehicle-row")].find(x=>x.textContent?.includes("구간 기준 위치")).click()')
      await until('[...document.querySelectorAll(".vehicle-row")].some(x=>x.classList.contains("selected"))', 'vehicle selection')
    }
    await send('Emulation.setDeviceMetricsOverride', { width: 390, height: 844, deviceScaleFactor: 1, mobile: true })
    await new Promise((resolve) => setTimeout(resolve, 600))
    const mobile = await evalJs('({ width:document.documentElement.clientWidth, mapWidth:document.querySelector(".map-panel").clientWidth, toggle:!!document.querySelector(".mobile-list-toggle"), rows:document.querySelectorAll(".vehicle-row").length })')
    if (mobile.width !== mobile.mapWidth || !mobile.toggle || (desktop.vehicles && !mobile.rows)) throw new Error('Mobile vehicle layout mismatch')
    if (process.argv.includes('--poll')) {
      for (let second = 0; second < 85 && vehicleRequests < 2; second++) await new Promise((resolve) => setTimeout(resolve, 1_000))
      if (vehicleRequests < 2) {
        const state = await evalJs('({hidden:document.hidden,online:navigator.onLine,selected:document.querySelectorAll(".selected-route").length,status:document.querySelector(".vehicle-group-heading")?.textContent?.slice(0,80)})')
        throw new Error(`60-second vehicle polling was not observed: ${vehicleRequests} request(s), ${JSON.stringify(state)}`)
      }
    }
    process.stdout.write(JSON.stringify({ desktop, mobile, sectionSelectionTested: sectionClickable, vehicleRequests, exceptions }) + '\n')
    if (exceptions) process.exitCode = 1
  } finally { socket.close() }
}
main().catch((error) => { process.stderr.write(`Vehicle UI QA failed: ${error.message}\n`); process.exitCode = 1 })
