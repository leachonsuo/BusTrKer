// Render a local, key-free close-up of one normalized route-shape window.
const fs = require('node:fs')
const path = require('node:path')

const [fixtureFile, fromText, toText, stopFromText, stopToText, outputFile] = process.argv.slice(2)
if (!outputFile) {
  process.stderr.write('Usage: node scripts/render-route-direction-window.cjs <fixture> <shape-from> <shape-to> <stop-from> <stop-to> <output.svg>\n')
  process.exit(2)
}
const fixture = JSON.parse(fs.readFileSync(fixtureFile, 'utf8').replace(/^\uFEFF/, ''))
const shape = fixture.shape?.shape ?? fixture.shape
const stops = fixture.stops?.stops ?? fixture.stops
const from = Number(fromText), to = Number(toText)
const stopFrom = Number(stopFromText), stopTo = Number(stopToText)
if (![from, to, stopFrom, stopTo].every(Number.isInteger) || from < 0 || to >= shape.points.length ||
    to <= from || stopFrom < 1 || stopTo < stopFrom) throw new Error('Invalid index range')
const selected = shape.points.slice(from, to + 1)
const visits = stops.filter((stop) => stop.sequence >= stopFrom && stop.sequence <= stopTo)
const meanLatitude = selected.reduce((sum, point) => sum + point.latitude, 0) / selected.length
const cosine = Math.cos(meanLatitude * Math.PI / 180)
const project = (point) => ({ x: point.longitude * cosine, y: -point.latitude })
const projected = [...selected, ...visits.map((stop) => stop.position)].map(project)
const bounds = { minX: Math.min(...projected.map((point) => point.x)), maxX: Math.max(...projected.map((point) => point.x)),
  minY: Math.min(...projected.map((point) => point.y)), maxY: Math.max(...projected.map((point) => point.y)) }
const width = 1040, height = 740, pad = 90
const scale = Math.min((width - pad * 2) / (bounds.maxX - bounds.minX || 1),
  (height - pad * 2) / (bounds.maxY - bounds.minY || 1))
const pixel = (point) => { const p = project(point); return { x: pad + (p.x - bounds.minX) * scale,
  y: pad + (p.y - bounds.minY) * scale } }
const xml = (value) => String(value).replace(/[&<>"']/g, (char) => ({ '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;', "'": '&apos;' })[char])
const svg = [`<svg xmlns="http://www.w3.org/2000/svg" width="${width}" height="${height}" viewBox="0 0 ${width} ${height}">`,
  '<rect width="100%" height="100%" fill="#f7f9fc"/>',
  '<defs><marker id="arrow" markerWidth="9" markerHeight="9" refX="7" refY="4.5" orient="auto"><path d="M1 1 L8 4.5 L1 8" fill="none" stroke="#1557bd" stroke-width="1.5"/></marker></defs>',
  `<text x="32" y="36" font-size="20" font-family="sans-serif" font-weight="700" fill="#18325a">route ${xml(shape.routeId.value)} · shape ${from}–${to}</text>`,
  '<text x="32" y="62" font-size="13" font-family="sans-serif" fill="#52637a">Blue: ordered shape and arrows · red: actual GBIS stop positions / visit sequences · no basemap</text>']
const pathData = selected.map((point, index) => { const p = pixel(point); return `${index ? 'L' : 'M'}${p.x.toFixed(2)} ${p.y.toFixed(2)}` }).join(' ')
svg.push(`<path d="${pathData}" fill="none" stroke="#2f6edf" stroke-width="3.5" stroke-linejoin="round"/>`)
for (let index = from + 3; index < to; index += 8) {
  const a = pixel(shape.points[index]), b = pixel(shape.points[index + 1])
  if (Math.hypot(b.x - a.x, b.y - a.y) < 4) continue
  svg.push(`<path d="M${a.x.toFixed(1)} ${a.y.toFixed(1)} L${b.x.toFixed(1)} ${b.y.toFixed(1)}" fill="none" stroke="#1557bd" stroke-width="2" marker-end="url(#arrow)"/>`)
}
for (let index = from; index <= to; index += 12) {
  const p = pixel(shape.points[index])
  svg.push(`<circle cx="${p.x.toFixed(1)}" cy="${p.y.toFixed(1)}" r="3" fill="#1557bd"/>`,
    `<text x="${(p.x + 5).toFixed(1)}" y="${(p.y - 5).toFixed(1)}" font-size="11" font-family="sans-serif" fill="#1557bd">${index}</text>`)
}
for (const stop of visits) {
  const p = pixel(stop.position)
  svg.push(`<circle cx="${p.x.toFixed(1)}" cy="${p.y.toFixed(1)}" r="6" fill="#e23a50" stroke="#fff" stroke-width="2"/>`,
    `<text x="${(p.x + 9).toFixed(1)}" y="${(p.y + 5).toFixed(1)}" font-size="12" font-family="sans-serif" font-weight="700" fill="#9d1730">${stop.sequence} ${xml(stop.name)}</text>`)
}
svg.push('</svg>')
fs.mkdirSync(path.dirname(outputFile), { recursive: true })
fs.writeFileSync(outputFile, `${svg.join('\n')}\n`)
process.stdout.write(`${outputFile}\n`)
