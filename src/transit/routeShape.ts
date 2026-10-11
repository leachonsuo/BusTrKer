import type { LatLng } from '../map/kakao'
import type { RouteShape } from './api'

interface PointMeters { x: number; y: number }
interface StraightPass { index: number; direction: PointMeters; offset: number; projected: PointMeters }

const METERS_PER_DEGREE = 111_320
const dot = (a: PointMeters, b: PointMeters) => a.x * b.x + a.y * b.y
const cross = (a: PointMeters, b: PointMeters) => a.x * b.y - a.y * b.x
const difference = (a: PointMeters, b: PointMeters): PointMeters => ({ x: a.x - b.x, y: a.y - b.y })
const magnitude = (point: PointMeters) => Math.hypot(point.x, point.y)

// The captured GBIS 11 shape uses one identical centerline vertex for both
// journeys even though the neighboring points follow separate carriageways.
// Scope the correction to that verified route until other shapes are examined.
export function separateSharedStraightVertices(shape: RouteShape): { shape: RouteShape; correctedPairs: number } {
  const points = shape.points
  if (shape.routeId.provider !== 'gbis' || shape.routeId.regionCode !== 'gyeonggi' ||
      shape.routeId.value !== '219000001' || points.length < 4) {
    return { shape, correctedPairs: 0 }
  }
  const origin = points[0]
  const longitudeScale = METERS_PER_DEGREE * Math.cos(origin.latitude * Math.PI / 180)
  const meters = points.map((point): PointMeters => ({
    x: (point.longitude - origin.longitude) * longitudeScale,
    y: (point.latitude - origin.latitude) * METERS_PER_DEGREE,
  }))
  const occurrences = new Map<string, number[]>()
  points.forEach((point, index) => {
    const key = `${point.latitude},${point.longitude}`
    const list = occurrences.get(key) ?? []
    list.push(index)
    occurrences.set(key, list)
  })
  const passAt = (index: number): StraightPass | null => {
    if (index <= 0 || index >= points.length - 1) return null
    const before = meters[index - 1], at = meters[index], after = meters[index + 1]
    const incoming = difference(at, before), outgoing = difference(after, at)
    const firstLength = magnitude(incoming), secondLength = magnitude(outgoing)
    if (firstLength < 5 || firstLength > 50 || secondLength < 5 || secondLength > 50) return null
    if (dot(incoming, outgoing) / (firstLength * secondLength) < Math.cos(55 * Math.PI / 180)) return null
    const direction = difference(after, before)
    const length = magnitude(direction)
    const fraction = dot(incoming, direction) / (length * length)
    if (fraction < 0.2 || fraction > 0.8) return null
    const offset = cross(direction, incoming) / length
    if (Math.abs(offset) < 2 || Math.abs(offset) > 8) return null
    return { index, direction, offset,
      projected: { x: before.x + direction.x * fraction, y: before.y + direction.y * fraction } }
  }
  const corrected = new Map<number, PointMeters>()
  for (const indices of occurrences.values()) {
    if (indices.length !== 2 || indices[1] - indices[0] < 8) continue
    const first = passAt(indices[0]), second = passAt(indices[1])
    if (!first || !second || first.offset * second.offset <= 0) continue
    const alignment = dot(first.direction, second.direction) /
      (magnitude(first.direction) * magnitude(second.direction))
    if (alignment > -Math.cos(25 * Math.PI / 180)) continue
    const separation = magnitude(difference(first.projected, second.projected))
    if (separation < 4 || separation > 20) continue
    corrected.set(first.index, first.projected)
    corrected.set(second.index, second.projected)
  }
  if (corrected.size === 0) return { shape, correctedPairs: 0 }
  return { shape: { ...shape, points: points.map((point, index): LatLng => {
    const projected = corrected.get(index)
    return projected ? { latitude: origin.latitude + projected.y / METERS_PER_DEGREE,
      longitude: origin.longitude + projected.x / longitudeScale } : point
  }) }, correctedPairs: corrected.size / 2 }
}
