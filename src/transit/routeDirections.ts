import type { LatLng } from '../map/kakao'
import { transitKey, type Route, type RouteShape, type RouteStop, type VehiclePosition } from './api'

export interface RouteDirection {
  key: string
  label: string
  startStop: RouteStop
  endStop: RouteStop
  stops: RouteStop[]
  shape: RouteShape
  stopSequenceRange: readonly [number, number]
  shapeIndexRange: readonly [number, number]
  splitConfidence: 'ordered-turn-and-shape'
}

export type DirectionFailureCode = 'INSUFFICIENT_ROUTE_DATA' | 'STOP_SEQUENCE_GAP' |
  'NO_TURN_BOUNDARY' | 'TURN_SEQUENCE_MISMATCH' | 'TURN_SHAPE_MISMATCH' |
  'AMBIGUOUS_TURN_MATCH' | 'STOP_TOO_FAR' | 'STOP_SHAPE_SEQUENCE_MISMATCH' |
  'UNSUPPORTED_ROUTE_STRUCTURE'
export type DirectionSplit = { directions: readonly [RouteDirection, RouteDirection]; reason: null; code: null } |
  { directions: null; reason: string; code: DirectionFailureCode }

export const NEARBY_DIRECTION_METERS = 600
const MAX_STOP_TO_SHAPE_METERS = 35
const MAX_TURN_TO_SHAPE_METERS = 35
const METERS = 111_320

export function distanceMeters(a: LatLng, b: LatLng): number {
  const cosine = Math.cos((a.latitude + b.latitude) * Math.PI / 360)
  return Math.hypot((a.longitude - b.longitude) * METERS * cosine, (a.latitude - b.latitude) * METERS)
}

interface Projection { index: number; along: number; error: number }

function project(position: LatLng, points: LatLng[], from: number, to: number): Projection[] {
  const cosine = Math.cos(position.latitude * Math.PI / 180)
  const candidates: Projection[] = []
  let along = 0
  for (let index = from; index < to; index++) {
    const a = points[index], b = points[index + 1]
    const dx = (b.longitude - a.longitude) * METERS * cosine
    const dy = (b.latitude - a.latitude) * METERS
    const px = (position.longitude - a.longitude) * METERS * cosine
    const py = (position.latitude - a.latitude) * METERS
    const fraction = Math.max(0, Math.min(1, (px * dx + py * dy) / (dx * dx + dy * dy || 1)))
    candidates.push({ index: index + fraction, along: along + Math.hypot(dx, dy) * fraction,
      error: Math.hypot(px - dx * fraction, py - dy * fraction) })
    along += Math.hypot(dx, dy)
  }
  return candidates.sort((a, b) => a.error - b.error)
}

function orderedMatches(stops: RouteStop[], points: LatLng[], from: number, to: number): DirectionFailureCode | null {
  let previous: Projection[] = []
  for (const stop of stops) {
    const candidates = project(stop.position, points, from, to)
    const best = candidates[0]
    if (!best || best.error > MAX_STOP_TO_SHAPE_METERS) return 'STOP_TOO_FAR'
    // Keep only close candidates that fit the same existing distance policy. A later
    // visit of the same road is resolved by the ordered stops on both sides of it.
    const close = candidates.filter((candidate) => candidate.error <= Math.min(MAX_STOP_TO_SHAPE_METERS, best.error + 10))
    const reachable = previous.length ? close.filter((candidate) =>
      previous.some((prior) => candidate.index > prior.index + 0.05)) : close
    if (!reachable.length) return 'STOP_SHAPE_SEQUENCE_MISMATCH'
    previous = reachable
  }
  return null
}

/** An explicit turn and a unique, stop-ordered shape visit are required before splitting. */
export function splitRouteDirections(route: Route, shape: RouteShape | null, stops: RouteStop[]): DirectionSplit {
  if (!shape || shape.points.length < 4 || transitKey(shape.routeId) !== transitKey(route.id)) {
    return { directions: null, reason: '노선형상이 없거나 노선 ID가 일치하지 않습니다.', code: 'INSUFFICIENT_ROUTE_DATA' }
  }
  const ordered = [...stops].sort((a, b) => a.sequence - b.sequence)
  if (ordered.length < 4 || ordered.some((stop, index) => index && stop.sequence !== ordered[index - 1].sequence + 1)) {
    return { directions: null, reason: '경유 정류장 순서가 연속적이지 않습니다.', code: 'STOP_SEQUENCE_GAP' }
  }
  const turns = ordered.filter((stop) => stop.turnYn === true)
  if (turns.length !== 1) return { directions: null, reason: '회차 정류장이 하나로 확인되지 않습니다.', code: 'NO_TURN_BOUNDARY' }
  const turn = turns[0], turnAt = ordered.indexOf(turn)
  if (turnAt < 1 || turnAt >= ordered.length - 1 ||
      ordered.some((stop) => stop.turnSequence !== null && stop.turnSequence !== turn.sequence)) {
    return { directions: null, reason: '회차 순번이 경유 정류장 순서와 일치하지 않습니다.', code: 'TURN_SEQUENCE_MISMATCH' }
  }
  const turnCandidates = project(turn.position, shape.points, 0, shape.points.length - 1)
  const nearest = turnCandidates[0]
  if (!nearest || nearest.error > MAX_TURN_TO_SHAPE_METERS) {
    return { directions: null, reason: '회차 지점을 노선형상에서 유일하게 찾지 못했습니다.', code: 'TURN_SHAPE_MISMATCH' }
  }
  // A turn stop can be close to both sides of a loop. Test every nearby visit
  // against the entire official stop order before calling the boundary ambiguous.
  const plausibleTurns = turnCandidates.filter((candidate) => candidate.error <=
    Math.min(MAX_TURN_TO_SHAPE_METERS, nearest.error + 10)).sort((a, b) => a.along - b.along)
  const turnVisits: Projection[][] = []
  for (const candidate of plausibleTurns) {
    const visit = turnVisits.at(-1)
    if (!visit || candidate.along - visit[0].along > 80) turnVisits.push([candidate])
    else visit.push(candidate)
  }
  const validVisits: { splitIndex: number }[] = []
  let nearestFailure: { error: number; code: DirectionFailureCode } | null = null
  for (const visit of turnVisits) {
    const tried = new Set<number>()
    for (const candidate of [...visit].sort((a, b) => a.error - b.error)) {
      const boundary = Math.ceil(candidate.index)
      if (tried.has(boundary)) continue
      tried.add(boundary)
      if (boundary < 2 || boundary > shape.points.length - 3) {
        if (!nearestFailure || candidate.error < nearestFailure.error) {
          nearestFailure = { error: candidate.error, code: 'UNSUPPORTED_ROUTE_STRUCTURE' }
        }
        continue
      }
      const failure = orderedMatches(ordered.slice(0, turnAt + 1), shape.points, 0, boundary) ??
        orderedMatches(ordered.slice(turnAt + 1), shape.points, boundary, shape.points.length - 1)
      if (!failure) {
        validVisits.push({ splitIndex: boundary })
        break
      }
      if (!nearestFailure || candidate.error < nearestFailure.error) nearestFailure = { error: candidate.error, code: failure }
    }
    if (validVisits.length > 1) {
      return { directions: null, reason: '회차 지점을 노선형상에서 유일하게 찾지 못했습니다.', code: 'AMBIGUOUS_TURN_MATCH' }
    }
  }
  if (!validVisits.length) {
    return { directions: null, reason: '정류장 방문 순서와 형상의 진행 순서가 일치하지 않습니다.',
      code: nearestFailure?.code ?? 'STOP_SHAPE_SEQUENCE_MISMATCH' }
  }
  const splitIndex = validVisits[0].splitIndex
  const firstStops = ordered.slice(0, turnAt + 1)
  const secondStops = ordered.slice(turnAt)
  const routeKey = transitKey(route.id)
  const first: RouteDirection = {
    key: `${routeKey}:${ordered[0].sequence}-${turn.sequence}`, label: `${turn.name} 방면`,
    startStop: ordered[0], endStop: turn, stops: firstStops,
    shape: { ...shape, points: shape.points.slice(0, splitIndex + 1) },
    stopSequenceRange: [ordered[0].sequence, turn.sequence], shapeIndexRange: [0, splitIndex],
    splitConfidence: 'ordered-turn-and-shape',
  }
  const second: RouteDirection = {
    key: `${routeKey}:${turn.sequence}-${ordered.at(-1)!.sequence}`, label: `${ordered.at(-1)!.name} 방면`,
    startStop: turn, endStop: ordered.at(-1)!, stops: secondStops,
    shape: { ...shape, points: shape.points.slice(splitIndex) },
    stopSequenceRange: [turn.sequence, ordered.at(-1)!.sequence], shapeIndexRange: [splitIndex, shape.points.length - 1],
    splitConfidence: 'ordered-turn-and-shape',
  }
  return { directions: [first, second], reason: null, code: null }
}

export function nearestBoardingStop(direction: RouteDirection, position: LatLng): { stop: RouteStop; meters: number } | null {
  // The last stop has no following section on this direction.
  const candidates = direction.stops.slice(0, -1).map((stop) => ({ stop, meters: distanceMeters(stop.position, position) }))
  return candidates.sort((a, b) => a.meters - b.meters)[0] ?? null
}

/** The arrow follows the ordered shape immediately after this boarding visit. */
export function boardingDirectionArrow(direction: RouteDirection, stop: RouteStop): string | null {
  if (!direction.stops.some((visit) => visit.sequence === stop.sequence && transitKey(visit.id) === transitKey(stop.id)) ||
      stop.sequence >= direction.stopSequenceRange[1]) return null
  const points = direction.shape.points
  const matches = project(stop.position, points, 0, points.length - 1)
  const match = matches[0]
  if (!match || match.error > MAX_STOP_TO_SHAPE_METERS || matches.some((other) =>
    other.error <= match.error + 5 && Math.abs(other.along - match.along) > 30)) return null
  const segment = Math.floor(match.index)
  const fraction = match.index - segment
  const origin = { latitude: points[segment].latitude + (points[segment + 1].latitude - points[segment].latitude) * fraction,
    longitude: points[segment].longitude + (points[segment + 1].longitude - points[segment].longitude) * fraction }
  let target = points[segment + 1]
  for (let index = segment + 1; index < points.length; index++) {
    target = points[index]
    if (distanceMeters(origin, target) >= 15) break
  }
  if (distanceMeters(origin, target) < 5) return null
  const east = (target.longitude - origin.longitude) * Math.cos(origin.latitude * Math.PI / 180)
  const north = target.latitude - origin.latitude
  const sector = Math.round(Math.atan2(east, north) / (Math.PI / 4))
  return ['↑', '↗', '→', '↘', '↓', '↙', '←', '↖'][(sector + 8) % 8]
}

export function hasNearbyBoardingStop(directions: readonly RouteDirection[], position: LatLng | null,
  accuracyMeters: number | null): boolean {
  if (!position || accuracyMeters === null || !Number.isFinite(accuracyMeters) || accuracyMeters > 100) return false
  return directions.some((direction) => (nearestBoardingStop(direction, position)?.meters ?? Infinity) <= NEARBY_DIRECTION_METERS + 1e-6)
}

export function vehicleBelongsToDirection(vehicle: VehiclePosition, direction: RouteDirection): boolean {
  if (transitKey(vehicle.routeId) !== transitKey(direction.shape.routeId) || !vehicle.sectionVerified || !vehicle.nextStopId ||
      vehicle.stationSequence < direction.stopSequenceRange[0] ||
      vehicle.stationSequence >= direction.stopSequenceRange[1]) return false
  const current = direction.stops.find((stop) => stop.sequence === vehicle.stationSequence)
  const next = direction.stops.find((stop) => stop.sequence === vehicle.stationSequence + 1)
  return !!current && !!next && transitKey(current.id) === transitKey(vehicle.currentStopId) &&
    transitKey(next.id) === transitKey(vehicle.nextStopId)
}
