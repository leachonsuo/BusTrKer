// Read-only geometry audit of the sanitized Goyang 11 route fixture.
const fs = require('node:fs')
const path = require('node:path')

const fixture = JSON.parse(fs.readFileSync(path.join(__dirname, 'fixtures', 'goyang-11-sanitized.json'), 'utf8'))
const points = fixture.shape.shape.points
const origin = points[0]
const cosine = Math.cos(origin.latitude * Math.PI / 180)
const xy = points.map((point) => ({ x: (point.longitude - origin.longitude) * 111_320 * cosine,
  y: (point.latitude - origin.latitude) * 111_320 }))
const length = (a, b) => Math.hypot(a.x - b.x, a.y - b.y)
const cross = (a, b) => a.x * b.y - a.y * b.x
const subtract = (a, b) => ({ x: a.x - b.x, y: a.y - b.y })
const segments = xy.slice(1).map((point, index) => ({ index, a: xy[index], b: point, meters: length(xy[index], point) }))
const intersections = []
for (let i = 0; i < segments.length; i++) for (let j = i + 2; j < segments.length; j++) {
  const first = segments[i], second = segments[j]
  const r = subtract(first.b, first.a), s = subtract(second.b, second.a)
  const denominator = cross(r, s)
  if (Math.abs(denominator) < 1e-6) continue
  const between = subtract(second.a, first.a)
  const t = cross(between, s) / denominator, u = cross(between, r) / denominator
  if (t > 0.005 && t < 0.995 && u > 0.005 && u < 0.995) {
    intersections.push({ first: i, second: j, gap: j - i, meters: [Math.round(first.meters), Math.round(second.meters)],
      point: { latitude: origin.latitude + (first.a.y + t * r.y) / 111_320,
        longitude: origin.longitude + (first.a.x + t * r.x) / (111_320 * cosine) } })
  }
}
const turns = []
for (let i = 1; i < xy.length - 1; i++) {
  const before = subtract(xy[i], xy[i - 1]), after = subtract(xy[i + 1], xy[i])
  const one = length(xy[i], xy[i - 1]), two = length(xy[i + 1], xy[i])
  if (one < 1 || two < 1) continue
  const degrees = Math.acos(Math.max(-1, Math.min(1, (before.x * after.x + before.y * after.y) / (one * two)))) * 180 / Math.PI
  if (degrees >= 120 && one <= 160 && two <= 160) turns.push({ vertex: i, degrees: Math.round(degrees), meters: [Math.round(one), Math.round(two)], point: points[i] })
}
const distances = segments.map((segment) => segment.meters).sort((a, b) => a - b)
const median = distances[Math.floor(distances.length / 2)]
const local = intersections.filter((item) => item.gap <= 12)
const long = segments.filter((segment) => segment.meters >= 150)
const repeats = new Map()
points.forEach((point, index) => {
  const key = `${point.latitude},${point.longitude}`
  repeats.set(key, [...(repeats.get(key) ?? []), index])
})
const sharedByJourneys = [...repeats.values()].filter((indices) => indices.length > 1 && indices.at(-1) - indices[0] >= 8)
console.log(JSON.stringify({ points: points.length, segments: segments.length,
  distanceMeters: { median: Math.round(median), p95: Math.round(distances[Math.floor(distances.length * .95)]),
    max: Math.round(distances.at(-1)), over150: long.length },
  intersections: { total: intersections.length, within12Segments: local.length },
  sharedByJourneys: sharedByJourneys.length,
  sharpTurns: turns }, null, 2))
