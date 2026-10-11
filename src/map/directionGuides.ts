import type { LatLng } from './kakao'
import type { RouteDirection } from '../transit/routeDirections'

export interface GuidePlacement { key: string; label: string; position: LatLng; angle: number; x: number; y: number }
export interface ScreenRect { left: number; top: number; right: number; bottom: number }

type Project = (point: LatLng) => { x: number; y: number }
type Candidate = GuidePlacement & { userMeters: number; centerPixels: number; width: number }

function meters(a: LatLng, b: LatLng): number {
  return Math.hypot((a.longitude - b.longitude) * 111_320 * Math.cos(a.latitude * Math.PI / 180),
    (a.latitude - b.latitude) * 111_320)
}

function rect(candidate: Candidate): ScreenRect {
  return { left: candidate.x - candidate.width / 2, right: candidate.x + candidate.width / 2,
    top: candidate.y - 53, bottom: candidate.y - 7 }
}

function overlaps(a: ScreenRect, b: ScreenRect, padding = 0): boolean {
  return a.left < b.right + padding && a.right + padding > b.left &&
    a.top < b.bottom + padding && a.bottom + padding > b.top
}

function candidatesFor(direction: RouteDirection, project: Project, width: number, height: number,
  user: LatLng | null, blocked: readonly ScreenRect[]): Candidate[] {
  const points = direction.shape.points
  const stops = direction.stops
  if (direction.splitConfidence !== 'ordered-turn-and-shape' || points.length < 3 || stops.length < 2 ||
      stops[0].sequence !== direction.stopSequenceRange[0] || stops.at(-1)?.sequence !== direction.stopSequenceRange[1] ||
      stops.some((stop, index) => index > 0 && stop.sequence !== stops[index - 1].sequence + 1)) return []

  const pixels = points.map(project)
  const lengths = points.slice(1).map((_, index) => Math.hypot(pixels[index + 1].x - pixels[index].x,
    pixels[index + 1].y - pixels[index].y))
  const totalMeters = points.slice(1).reduce((sum, point, index) => sum + meters(points[index], point), 0)
  const turnClearance = Math.min(65, totalMeters * 0.12)
  const labelWidth = Math.min(190, Math.max(95, 54 + direction.label.length * 11))
  const result: Candidate[] = []
  for (let index = 1; index < points.length - 1; index++) {
    const point = points[index], screen = pixels[index]
    if (!Number.isFinite(screen.x) || !Number.isFinite(screen.y) ||
        screen.x < labelWidth / 2 + 8 || screen.x > width - labelWidth / 2 - 8 ||
        screen.y < 62 || screen.y > height - 20 ||
        (user && meters(point, user) < 20) ||
        meters(point, direction.startStop.position) < turnClearance ||
        meters(point, direction.endStop.position) < turnClearance) continue

    // A repeated visit at the same coordinate cannot identify one travel tangent.
    if (points.some((other, otherIndex) => Math.abs(otherIndex - index) > 10 && meters(point, other) < 10)) continue
    let from = index, to = index, before = 0, after = 0
    while (from > 0 && before < 12) before += lengths[--from]
    while (to < points.length - 1 && after < 12) after += lengths[to++]
    if (before < 9 || after < 9 ||
        lengths.slice(from, to).some((_, offset) => {
          const distance = meters(points[from + offset], points[from + offset + 1])
          return distance < 0.5 || distance > 120
        })) continue

    const incoming = { x: screen.x - pixels[from].x, y: screen.y - pixels[from].y }
    const outgoing = { x: pixels[to].x - screen.x, y: pixels[to].y - screen.y }
    const straightness = (incoming.x * outgoing.x + incoming.y * outgoing.y) /
      (Math.hypot(incoming.x, incoming.y) * Math.hypot(outgoing.x, outgoing.y))
    if (!Number.isFinite(straightness) || straightness < 0.8) continue
    const dx = pixels[to].x - pixels[from].x, dy = pixels[to].y - pixels[from].y
    const candidate: Candidate = { key: direction.key, label: direction.label, position: point,
      angle: Math.atan2(dy, dx) * 180 / Math.PI, x: screen.x, y: screen.y,
      userMeters: user ? meters(user, point) : Infinity,
      centerPixels: Math.hypot(screen.x - width / 2, screen.y - height / 2), width: labelWidth }
    if (blocked.some((area) => overlaps(rect(candidate), area, 8))) continue
    result.push(candidate)
  }
  return result
}

/** Returns no labels unless both verified directions have separate, legible road positions. */
export function pickDirectionGuides(directions: readonly RouteDirection[], project: Project,
  width: number, height: number, user: LatLng | null, accuracyMeters: number | null,
  blocked: readonly ScreenRect[] = []): GuidePlacement[] {
  if (directions.length !== 2 || width < 240 || height < 220) return []
  const preciseUser = user && accuracyMeters !== null && Number.isFinite(accuracyMeters) && accuracyMeters <= 100 ? user : null
  const raw = directions.map((direction) => candidatesFor(direction, project, width, height, preciseUser, blocked))
  const angleGap = (a: Candidate, b: Candidate) => Math.abs(((a.angle - b.angle + 540) % 360) - 180)
  // Two shapes using the same nearby road in the same direction do not identify opposite journeys.
  const options = raw.map((candidates, index) => candidates.filter((candidate) =>
    !raw[1 - index].some((other) => meters(candidate.position, other.position) < 25 && angleGap(candidate, other) < 65)))
  if (!options[0].length || !options[1].length) return []
  const bestPair = (first: Candidate[], second: Candidate[], near: boolean): [Candidate, Candidate] | null => {
    let best: [Candidate, Candidate] | null = null
    let bestScore = Infinity
    for (const a of first) for (const b of second) {
      if (overlaps(rect(a), rect(b), 12)) continue
      const gap = Math.hypot(a.x - b.x, a.y - b.y)
      if (gap < 85 && angleGap(a, b) < 65) continue
      const score = near ? a.userMeters + b.userMeters + gap * 0.2 :
        a.centerPixels + b.centerPixels + gap * 0.15
      if (score < bestScore) { best = [a, b]; bestScore = score }
    }
    return best
  }
  const nearby = preciseUser ? bestPair(
    options[0].filter((candidate) => candidate.userMeters <= 600).sort((a, b) => a.userMeters - b.userMeters).slice(0, 45),
    options[1].filter((candidate) => candidate.userMeters <= 600).sort((a, b) => a.userMeters - b.userMeters).slice(0, 45), true) : null
  const visible = nearby ?? bestPair(
    [...options[0]].sort((a, b) => a.centerPixels - b.centerPixels).slice(0, 45),
    [...options[1]].sort((a, b) => a.centerPixels - b.centerPixels).slice(0, 45), false)
  return visible?.map(({ key, label, position, angle, x, y }) => ({ key, label, position, angle, x, y })) ?? []
}
