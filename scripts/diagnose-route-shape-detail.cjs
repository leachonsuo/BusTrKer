// Offline, ordered geometry inspection of the sanitized GBIS Goyang 11 snapshot.
// No API requests, map tiles, vehicle identifiers, or route coordinates are invented.
const fs = require('node:fs')
const path = require('node:path')
const ts = require('typescript')

const fixture = JSON.parse(fs.readFileSync(path.join(__dirname, 'fixtures', 'goyang-11-sanitized.json'), 'utf8'))
const original = fixture.shape.shape
const source = fs.readFileSync(path.join(__dirname, '..', 'src', 'transit', 'routeShape.ts'), 'utf8')
const code = ts.transpileModule(source, { compilerOptions: {
  module: ts.ModuleKind.CommonJS, target: ts.ScriptTarget.ES2022,
} }).outputText
const loaded = { exports: {} }
new Function('module', 'exports', 'require', code)(loaded, loaded.exports, require)
const corrected = loaded.exports.separateSharedStraightVertices(original).shape

const R = 111_320
const cosine = Math.cos(original.points[0].latitude * Math.PI / 180)
const position = (point) => ({ x: point.longitude * R * cosine, y: point.latitude * R })
const distance = (a, b) => Math.hypot((a.latitude - b.latitude) * R, (a.longitude - b.longitude) * R * cosine)
const turn = (points, index) => {
  if (index <= 0 || index >= points.length - 1) return null
  const a = position(points[index - 1]), b = position(points[index]), c = position(points[index + 1])
  const u = { x: b.x - a.x, y: b.y - a.y }, v = { x: c.x - b.x, y: c.y - b.y }
  const size = Math.hypot(u.x, u.y) * Math.hypot(v.x, v.y)
  return size < 1 ? null : Math.acos(Math.max(-1, Math.min(1, (u.x * v.x + u.y * v.y) / size))) * 180 / Math.PI
}
const round = (value, digits = 1) => Number(value.toFixed(digits))
const esc = (text) => String(text).replace(/[&<>"']/g, (char) => ({ '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;', "'": '&#39;' })[char])

const regions = {
  first: { title: 'Image 1: Won-dang middle school, two carriageways',
    passes: [[277, 288], [682, 692]], stops: [32, 73], focus: [283, 686] },
  second: { title: 'Image 2: city hall approach and return',
    passes: [[293, 306], [664, 678]], stops: [33, 71, 72], focus: [300, 670] },
  thirdSmall: { title: 'Image 3: western small circle, Won-dang market',
    passes: [[312, 329], [643, 660]], stops: [34, 35, 70], focus: [319, 651] },
  thirdMiddle: { title: 'Image 3: middle small circle, south-east approach',
    passes: [[329, 341], [629, 644]], stops: [36, 68, 69], focus: [335, 635] },
  thirdLarge: { title: 'Image 3: large circle, city office spur',
    passes: [[336, 349], [615, 638]], stops: [36, 37, 67, 68], focus: [340, 344, 345, 620, 623, 626, 630] },
}

function intersections(points, passes) {
  const segments = passes.flatMap(([start, end]) => Array.from({ length: end - start }, (_, offset) => start + offset))
  const xy = points.map(position)
  const cross = (a, b) => a.x * b.y - a.y * b.x
  const minus = (a, b) => ({ x: a.x - b.x, y: a.y - b.y })
  const result = []
  for (let left = 0; left < segments.length; left++) for (let right = left + 1; right < segments.length; right++) {
    const i = segments[left], j = segments[right]
    if (Math.abs(i - j) <= 1) continue
    const a = xy[i], b = xy[i + 1], c = xy[j], d = xy[j + 1]
    const r = minus(b, a), s = minus(d, c), denominator = cross(r, s)
    if (Math.abs(denominator) < 1e-7) continue
    const ac = minus(c, a), t = cross(ac, s) / denominator, u = cross(ac, r) / denominator
    if (t < -1e-7 || t > 1 + 1e-7 || u < -1e-7 || u > 1 + 1e-7) continue
    const kind = t > 0.001 && t < 0.999 && u > 0.001 && u < 0.999 ? 'interior' : 'endpoint-touch'
    result.push({ segments: [i, j], kind,
      latitude: round((a.y + t * r.y) / R, 8), longitude: round((a.x + t * r.x) / (R * cosine), 8) })
  }
  return result
}

function inspectRegion(key) {
  const region = regions[key]
  if (!region) throw Error(`Unknown region: ${key}`)
  const rows = region.passes.flatMap(([start, end], pass) => Array.from({ length: end - start + 1 }, (_, offset) => {
    const index = start + offset, point = original.points[index], adjusted = corrected.points[index]
    return { pass: pass === 0 ? 'outbound' : 'return', index, latitude: point.latitude, longitude: point.longitude,
      nextMeters: index < end ? round(distance(point, original.points[index + 1])) : null,
      headingDegrees: index < end ? round((Math.atan2(position(original.points[index + 1]).x - position(point).x,
        position(original.points[index + 1]).y - position(point).y) * 180 / Math.PI + 360) % 360) : null,
      turnDegrees: turn(original.points, index) === null ? null : round(turn(original.points, index)),
      correctedLatitude: adjusted.latitude, correctedLongitude: adjusted.longitude,
      movedMeters: round(distance(point, adjusted), 2) }
  }))
  const stops = fixture.stops.stops.filter((stop) => region.stops.includes(stop.sequence)).map((stop) => {
    const matchingPass = stop.sequence < 52 ? 0 : 1
    const [start, end] = region.passes[matchingPass]
    const closest = Array.from({ length: end - start + 1 }, (_, offset) => start + offset)
      .sort((a, b) => distance(stop.position, original.points[a]) - distance(stop.position, original.points[b]))[0]
    return { sequence: stop.sequence, name: stop.name, latitude: stop.position.latitude,
      longitude: stop.position.longitude, nearestIndexInPass: closest,
      distanceToNearestMeters: round(distance(stop.position, original.points[closest])) }
  })
  const repeated = new Map()
  original.points.forEach((point, index) => {
    const key = `${point.latitude},${point.longitude}`
    repeated.set(key, [...(repeated.get(key) ?? []), index])
  })
  const localIndexes = new Set(rows.map((row) => row.index))
  const sharedCoordinates = [...repeated].filter(([, list]) => list.length > 1 && list.some((index) => localIndexes.has(index)))
    .map(([coordinate, indices]) => ({ coordinate, indices }))
  return { region: key, title: region.title, source: 'saved sanitized GBIS 11 snapshot, normalized zero-based point indexes',
    passes: region.passes, stops, sharedCoordinates, intersections: intersections(original.points, region.passes),
    correctedIntersections: intersections(corrected.points, region.passes), rows }
}

function renderSvg(report) {
  const region = regions[report.region], width = 1500, panelWidth = 720, panelHeight = 720
  const startY = 80, tableY = 875, rowHeight = 22
  const height = tableY + Math.max(report.rows.length, report.stops.length) * rowHeight + 80
  const all = [...report.rows.map((row) => original.points[row.index]), ...report.stops]
  const minX = Math.min(...all.map((point) => position(point).x)), maxX = Math.max(...all.map((point) => position(point).x))
  const minY = Math.min(...all.map((point) => position(point).y)), maxY = Math.max(...all.map((point) => position(point).y))
  const span = Math.max((maxX - minX) / 600, (maxY - minY) / 600, 0.05)
  const xy = (point, offsetX) => {
    const p = position(point)
    return { x: offsetX + 60 + (p.x - minX) / span, y: startY + 660 - (p.y - minY) / span }
  }
  const s = [`<svg xmlns="http://www.w3.org/2000/svg" width="${width}" height="${height}" viewBox="0 0 ${width} ${height}">`,
    `<rect width="${width}" height="${height}" fill="#f7f9fc"/>`,
    `<style>text{font-family:Arial,'Malgun Gothic',sans-serif;fill:#203047}.title{font-size:22px;font-weight:700}.small{font-size:12px}.row{font-size:13px;font-family:Consolas,monospace}.row.sharp{fill:#bd3333;font-weight:700}.heading{font-size:14px;font-weight:700}</style>`,
    `<defs><marker id="out" markerWidth="5" markerHeight="5" refX="4" refY="2.5" orient="auto"><path d="M0 0 L5 2.5 L0 5" fill="none" stroke="#2463d4" stroke-width="1.2"/></marker>`,
    `<marker id="back" markerWidth="5" markerHeight="5" refX="4" refY="2.5" orient="auto"><path d="M0 0 L5 2.5 L0 5" fill="none" stroke="#df6031" stroke-width="1.2"/></marker></defs>`,
    `<text x="25" y="35" class="title">${esc(report.title)}</text>`,
    `<text x="25" y="55" class="small">Saved GBIS snapshot | ordered zero-based point index | blue outbound, orange return | no road tiles</text>`]
  for (const [version, points, offsetX] of [['Original', original.points, 0], ['Adjusted', corrected.points, 750]]) {
    s.push(`<rect x="${offsetX + 15}" y="75" width="${panelWidth}" height="${panelHeight}" rx="12" fill="white" stroke="#dce4ed"/>`,
      `<text x="${offsetX + 35}" y="100" class="heading">${version} · route 219000001</text>`)
    for (const [pass, [start, end]] of region.passes.entries()) {
      const stroke = pass === 0 ? '#2463d4' : '#df6031', marker = pass === 0 ? 'out' : 'back'
      for (let index = start; index < end; index++) {
        const a = xy(points[index], offsetX), b = xy(points[index + 1], offsetX)
        s.push(`<path d="M${round(a.x)} ${round(a.y)}L${round(b.x)} ${round(b.y)}" stroke="${stroke}" stroke-width="3" fill="none"/>`)
        if (distance(points[index], points[index + 1]) >= 25) {
          const from = { x: a.x * .6 + b.x * .4, y: a.y * .6 + b.y * .4 }
          const to = { x: a.x * .4 + b.x * .6, y: a.y * .4 + b.y * .6 }
          s.push(`<path d="M${round(from.x)} ${round(from.y)}L${round(to.x)} ${round(to.y)}" stroke="${stroke}" stroke-width="1.5" fill="none" marker-end="url(#${marker})"/>`)
        }
      }
      for (let index = start; index <= end; index++) {
        const p = xy(points[index], offsetX), moved = distance(original.points[index], corrected.points[index])
        s.push(`<circle cx="${round(p.x)}" cy="${round(p.y)}" r="${region.focus.includes(index) ? 5 : 2.5}" fill="${stroke}"/>`)
        if (region.focus.includes(index) || (index - start) % 3 === 0) {
          const dy = pass === 0 ? -7 : 14
          s.push(`<text x="${round(p.x + 5)}" y="${round(p.y + dy)}" font-size="11" font-weight="bold" fill="${stroke}">${index}${moved > 0.01 ? '*' : ''}</text>`)
        }
        if (version === 'Adjusted' && moved > 0.01) {
          const before = xy(original.points[index], offsetX)
          s.push(`<path d="M${round(before.x)} ${round(before.y)}L${round(p.x)} ${round(p.y)}" stroke="#9a25a8" stroke-width="1.5" stroke-dasharray="3 2"/>`)
        }
      }
    }
    for (const stop of report.stops) {
      const p = xy(stop, offsetX)
      s.push(`<circle cx="${round(p.x)}" cy="${round(p.y)}" r="6" fill="white" stroke="#19896b" stroke-width="2"/>`,
        `<text x="${round(p.x + 8)}" y="${round(p.y - 8)}" font-size="11" fill="#116047">stop ${stop.sequence}</text>`)
    }
    s.push(`<text x="${offsetX + 35}" y="${startY + panelHeight - 20}" class="small">* corrected coordinate. Arrows follow increasing index; stops are unsnapped.</text>`)
  }
  s.push(`<text x="25" y="825" class="heading">Ordered segments · heading 0° north / 90° east · turn is angle between incoming and outgoing</text>`,
    `<text x="25" y="845" class="small">Sharp turns ≥ 55° bold red; each row's distance and heading lead to the next index within its pass.</text>`,
    `<text x="25" y="870" class="row" font-weight="bold">Pass   Index  Latitude    Longitude    Next m  Heading°  Turn°  Moved m</text>`)
  report.rows.forEach((row, line) => {
    const value = `${row.pass.padEnd(8)}${String(row.index).padStart(5)}  ${row.latitude.toFixed(6)}  ${row.longitude.toFixed(6)}  ${String(row.nextMeters ?? '-').padStart(6)}  ${String(row.headingDegrees ?? '-').padStart(8)}  ${String(row.turnDegrees ?? '-').padStart(5)}  ${String(row.movedMeters).padStart(7)}`
    s.push(`<text x="25" y="${tableY + line * rowHeight}" class="row${row.turnDegrees >= 55 ? ' sharp' : ''}">${esc(value)}</text>`)
  })
  let noteY = tableY + report.rows.length * rowHeight + 10
  s.push(`<text x="780" y="870" class="heading">Shared vertices and segment contacts</text>`)
  const notes = [...report.sharedCoordinates.map((item) => `point ${item.coordinate} → indexes ${item.indices.join(', ')}`),
    ...report.intersections.map((item) => `${item.kind}: ${item.segments[0]}→${item.segments[0] + 1} / ${item.segments[1]}→${item.segments[1] + 1}`)]
  notes.forEach((note, index) => s.push(`<text x="780" y="${tableY + index * 20}" class="small">${esc(note)}</text>`))
  noteY = Math.max(noteY, tableY + notes.length * 20 + 25)
  s.push(`<text x="780" y="${noteY}" class="heading">Nearest ordered stop coordinates</text>`)
  report.stops.forEach((stop, index) => s.push(`<text x="780" y="${noteY + 22 + index * 20}" class="small">${esc(`${stop.sequence} ${stop.name} → point ${stop.nearestIndexInPass} (${stop.distanceToNearestMeters}m)`)}</text>`))
  s.push('</svg>')
  return s.join('\n')
}

if (require.main === module) {
  const destination = process.argv[2] ?? path.join(__dirname, '..', 'diagnostics', 'route11')
  fs.mkdirSync(destination, { recursive: true })
  const reports = {}
  for (const key of Object.keys(regions)) {
    const report = inspectRegion(key)
    reports[key] = report
    fs.writeFileSync(path.join(destination, `${key}.svg`), renderSvg(report))
  }
  fs.writeFileSync(path.join(destination, 'geometry.json'), JSON.stringify(reports, null, 2))
  console.log(JSON.stringify({ destination, regions: Object.keys(reports),
    originalPoints: original.points.length, movedPoints: original.points.filter((point, index) => distance(point, corrected.points[index]) > 0.01).length,
    maxMovedMeters: round(Math.max(...original.points.map((point, index) => distance(point, corrected.points[index]))), 2),
    thirdLarge: { sharedCoordinates: reports.thirdLarge.sharedCoordinates,
      intersections: reports.thirdLarge.intersections, correctedIntersections: reports.thirdLarge.correctedIntersections } }, null, 2))
}

module.exports = { inspectRegion, intersections }
