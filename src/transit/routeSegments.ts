import type { LatLng } from '../map/kakao'
import type { RouteShape, RouteStop, VehiclePosition } from './api'

interface Anchor { segment: number; ratio: number; along: number; error: number; point: LatLng }
const METERS_PER_DEGREE = 111_320

function meters(a: LatLng, b: LatLng): number {
  const cosine = Math.cos((a.latitude + b.latitude) * Math.PI / 360)
  return Math.hypot((a.longitude - b.longitude) * METERS_PER_DEGREE * cosine,
    (a.latitude - b.latitude) * METERS_PER_DEGREE)
}

function anchors(position: LatLng, points: LatLng[], lengths: number[]): Anchor[] {
  const cosine = Math.cos(position.latitude * Math.PI / 180)
  const candidates: Anchor[] = []
  for (let index = 0; index < points.length - 1; index++) {
    const a = points[index], b = points[index + 1]
    const dx = (b.longitude - a.longitude) * cosine * METERS_PER_DEGREE
    const dy = (b.latitude - a.latitude) * METERS_PER_DEGREE
    const px = (position.longitude - a.longitude) * cosine * METERS_PER_DEGREE
    const py = (position.latitude - a.latitude) * METERS_PER_DEGREE
    const ratio = Math.max(0, Math.min(1, (px * dx + py * dy) / (dx * dx + dy * dy || 1)))
    const point = { latitude: a.latitude + (b.latitude - a.latitude) * ratio,
      longitude: a.longitude + (b.longitude - a.longitude) * ratio }
    const error = meters(position, point)
    if (error <= 75) candidates.push({ segment: index, ratio, along: lengths[index] + (lengths[index + 1] - lengths[index]) * ratio, error, point })
  }
  candidates.sort((a, b) => a.error - b.error)
  const distinct: Anchor[] = []
  for (const candidate of candidates) {
    if (distinct.every((other) => Math.abs(other.along - candidate.along) > 80)) distinct.push(candidate)
    if (distinct.length >= 12) break
  }
  return distinct
}

/** Returns only a section supported by both stop order and the supplied road shape. */
export function verifiedRoadSection(shape: RouteShape | null, stops: RouteStop[], vehicle: VehiclePosition): LatLng[] | null {
  if (!vehicle.sectionVerified || !vehicle.nextStopId || !shape || shape.points.length < 2) return null
  const ordered = [...stops].sort((a, b) => a.sequence - b.sequence)
  const current = ordered.find((stop) => stop.sequence === vehicle.stationSequence && stop.id.value === vehicle.currentStopId.value)
  const next = ordered.find((stop) => stop.sequence === vehicle.stationSequence + 1 && stop.id.value === vehicle.nextStopId?.value)
  if (!current || !next) return null
  const points = shape.points
  const lengths = [0]
  for (let i = 1; i < points.length; i++) lengths.push(lengths[i - 1] + meters(points[i - 1], points[i]))
  const starts = anchors(current.position, points, lengths)
  const ends = anchors(next.position, points, lengths)
  const previous = ordered.find((stop) => stop.sequence === current.sequence - 1)
  const following = ordered.find((stop) => stop.sequence === next.sequence + 1)
  const previousAnchors = previous ? anchors(previous.position, points, lengths) : []
  const followingAnchors = following ? anchors(following.position, points, lengths) : []
  const straight = meters(current.position, next.position)
  const possibilities = starts.flatMap((start) => ends.flatMap((end) => {
    const sectionLength = end.along - start.along
    if (sectionLength < 10 || sectionLength > Math.max(2500, straight * 4 + 200)) return []
    if (previous && previousAnchors.length && !previousAnchors.some((anchor) => anchor.along < start.along - 5)) return []
    if (following && followingAnchors.length && !followingAnchors.some((anchor) => anchor.along > end.along + 5)) return []
    return [{ start, end, score: start.error + end.error + sectionLength * 0.01 }]
  })).sort((a, b) => a.score - b.score)
  const best = possibilities[0]
  if (!best) return null
  const competing = possibilities.find((candidate) =>
    Math.abs(candidate.start.along - best.start.along) > 150 || Math.abs(candidate.end.along - best.end.along) > 150)
  if (competing && competing.score - best.score < 30) return null
  const path = [best.start.point]
  for (let index = best.start.segment + 1; index <= best.end.segment; index++) path.push(points[index])
  path.push(best.end.point)
  return path
}

export function groupVehicleSections<T extends { routeKey: string; stationSequence: number; path: LatLng[] }>(sections: T[]): T[][] {
  const groups = new Map<string, T[]>()
  for (const section of sections) {
    const first = section.path[0], last = section.path.at(-1)
    if (!first || !last) continue
    const id = `${section.routeKey}:${section.stationSequence}`
    groups.set(id, [...(groups.get(id) ?? []), section])
  }
  return [...groups.values()]
}
