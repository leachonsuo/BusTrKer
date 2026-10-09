// Prints only public route identity and derived validation metadata. Never print a URL, key, vehicle ID, plate, or response body.
const fs = require('node:fs')
const path = require('node:path')
const ts = require(path.join(__dirname, '..', '..', 'node_modules', 'typescript'))
const segmentSource = fs.readFileSync(path.join(__dirname, '..', '..', 'src', 'transit', 'routeSegments.ts'), 'utf8')
const segmentModule = { exports: {} }
new Function('module', 'exports', 'require', ts.transpileModule(segmentSource, { compilerOptions: { module: ts.ModuleKind.CommonJS, target: ts.ScriptTarget.ES2022 } }).outputText)(segmentModule, segmentModule.exports, require)
const { verifiedRoadSection } = segmentModule.exports
const secret = fs.readFileSync(path.join(__dirname, '..', '.secret.local'), 'utf8')
const key = /^PUBLIC_DATA_SERVICE_KEY=(.*)$/m.exec(secret)?.[1]?.trim()
if (!key) { process.stderr.write('Local service key is unavailable.\n'); process.exit(1) }
const base = 'https://apis.data.go.kr/6410000'
async function get(endpoint, params) {
  const url = new URL(base + endpoint)
  url.search = new URLSearchParams({ format: 'json', serviceKey: key, ...params }).toString()
  const response = await fetch(url, { signal: AbortSignal.timeout(8000) })
  return response.json()
}
const list = (value) => value == null ? [] : Array.isArray(value) ? value : [value]
async function run() {
  const search = await get('/busrouteservice/v2/getBusRouteListv2', { keyword: 'N' })
  const candidates = list(search?.response?.msgBody?.busRouteList)
    .filter((r) => String(r.regionName).includes('고양') && ['9709N', 'N5700'].includes(String(r.routeName)))
  for (const route of candidates) {
    const reply = await get('/buslocationservice/v2/getBusLocationListv2', { routeId: String(route.routeId) })
    const vehicles = list(reply?.response?.msgBody?.busLocationList)
    if (vehicles.length === 0) continue
    const stopsReply = await get('/busrouteservice/v2/getBusRouteStationListv2', { routeId: String(route.routeId) })
    const stops = list(stopsReply?.response?.msgBody?.busRouteStationList)
    const shapeReply = await get('/busrouteservice/v2/getBusRouteLineListv2', { routeId: String(route.routeId) })
    const points = list(shapeReply?.response?.msgBody?.busRouteLineList).sort((a, b) => Number(a.lineSeq) - Number(b.lineSeq))
      .map((row) => ({ latitude: Number(row.y), longitude: Number(row.x) }))
    const normalizedStops = stops.map((stop) => ({ sequence: Number(stop.stationSeq), id: { value: String(stop.stationId) },
      position: { latitude: Number(stop.y), longitude: Number(stop.x) } }))
    process.stdout.write(JSON.stringify({ routeId: route.routeId, routeName: route.routeName,
      vehicleCount: vehicles.length, stopCount: stops.length,
      vehicles: vehicles.map((vehicle) => {
        const bySeq = stops.find((stop) => String(stop.stationSeq) === String(vehicle.stationSeq))
        const byId = stops.find((stop) => String(stop.stationId) === String(vehicle.stationId))
        const current = normalizedStops.find((stop) => stop.sequence === Number(vehicle.stationSeq))
        const next = normalizedStops.find((stop) => stop.sequence === Number(vehicle.stationSeq) + 1)
        const section = verifiedRoadSection({ points }, normalizedStops, {
          sectionVerified: Number(vehicle.stateCd) === 2 && current?.id.value === String(vehicle.stationId) && Boolean(next),
          stationSequence: Number(vehicle.stationSeq), currentStopId: { value: String(vehicle.stationId) }, nextStopId: next?.id ?? null,
        })
        return { stateCd: vehicle.stateCd, stationSeq: vehicle.stationSeq,
          sequenceMatchesStationId: bySeq != null && String(bySeq.stationId) === String(vehicle.stationId),
          stationIdSequence: byId?.stationSeq ?? null,
          nextSequenceExists: Boolean(next), verifiedRoadPointCount: section?.length ?? 0 }
      }) }) + '\n')
  }
}
run().catch(() => { process.stderr.write('Live verification failed.\n'); process.exitCode = 1 })
