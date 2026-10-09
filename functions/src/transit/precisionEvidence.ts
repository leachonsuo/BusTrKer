import type { Coordinates } from './domain'

export type EvidenceLevel = 'verified' | 'candidate' | 'unverified'
export interface PrecisionFix {
  routeId: string
  vehicleNumber: string
  position: Coordinates
  collectedAtRaw: string
  directionRaw: number | null
}

function object(value: unknown): Record<string, unknown> | null {
  return value !== null && typeof value === 'object' && !Array.isArray(value) ? value as Record<string, unknown> : null
}

function required(value: unknown): string {
  const result = typeof value === 'string' || typeof value === 'number' ? String(value).trim() : ''
  if (!result) throw new Error('Precision required field missing')
  return result
}

function coordinate(value: unknown, limit: number): number {
  if (value === null || value === undefined || String(value).trim() === '') throw new Error('Precision coordinate missing')
  const number = Number(value)
  if (!Number.isFinite(number) || Math.abs(number) > limit) throw new Error('Precision coordinate invalid')
  return number
}

/** Parses the observed K0/header/body/items.item JSON contract, without assuming a timezone. */
export function parsePrecisionLocations(raw: unknown): PrecisionFix[] {
  const outer = object(raw)
  const root = object(outer?.response) ?? outer
  const header = object(root?.header)
  const body = object(root?.body)
  if (String(header?.resultCode ?? '') !== 'K0' || !body) throw new Error('Precision response invalid or unsuccessful')
  const total = Number(body.totalCount)
  if (!Number.isInteger(total) || total < 0) throw new Error('Precision totalCount invalid')
  const items = object(body.items)
  const value = items?.item
  if (total > 0 && value == null) throw new Error('Precision rows missing')
  const rows = value == null ? [] : Array.isArray(value) ? value : [value]
  if (rows.length > total) throw new Error('Precision row count exceeds totalCount')
  return rows.map((item) => {
    const row = object(item)
    if (!row) throw new Error('Precision row invalid')
    const direction = row.oprDrct == null || String(row.oprDrct).trim() === '' ? null : Number(row.oprDrct)
    return { routeId: required(row.rteId), vehicleNumber: required(row.vhclNo),
      position: { latitude: coordinate(row.lat, 90), longitude: coordinate(row.lot, 180) },
      collectedAtRaw: required(row.gthrDt),
      directionRaw: direction !== null && Number.isFinite(direction) && direction >= 0 && direction < 360 ? direction : null }
  })
}

export type FixAge = { status: 'fresh' | 'delayed' | 'stale' | 'future' | 'invalid' | 'timezone-unknown';
  observedAt: string | null; ageSeconds: number | null }

/** Offset must come from documented provider evidence; null never produces a current location. */
export function assessFixAge(raw: string, nowMs: number, confirmedOffsetMinutes: number | null): FixAge {
  const match = /^(\d{4})-(\d{2})-(\d{2})[ T](\d{2}):(\d{2}):(\d{2})(?:([Zz])|([+-])(\d{2}):(\d{2}))?$/.exec(raw.trim())
  if (!match) return { status: 'invalid', observedAt: null, ageSeconds: null }
  const [, year, month, day, hour, minute, second, zulu, sign, zoneHour, zoneMinute] = match
  const parts = [year, month, day, hour, minute, second].map(Number)
  const [y, mo, d, h, mi, s] = parts
  const base = Date.UTC(y, mo - 1, d, h, mi, s)
  const calendar = new Date(base)
  if (!Number.isFinite(base) || calendar.getUTCFullYear() !== y || calendar.getUTCMonth() !== mo - 1 ||
      calendar.getUTCDate() !== d || calendar.getUTCHours() !== h || calendar.getUTCMinutes() !== mi || calendar.getUTCSeconds() !== s) {
    return { status: 'invalid', observedAt: null, ageSeconds: null }
  }
  let offset = confirmedOffsetMinutes
  if (zulu) offset = 0
  else if (sign) {
    const hours = Number(zoneHour), minutes = Number(zoneMinute)
    if (hours > 14 || minutes > 59 || (hours === 14 && minutes !== 0)) return { status: 'invalid', observedAt: null, ageSeconds: null }
    offset = (sign === '+' ? 1 : -1) * (hours * 60 + minutes)
  }
  if (offset === null) return { status: 'timezone-unknown', observedAt: null, ageSeconds: null }
  if (!Number.isInteger(offset) || Math.abs(offset) > 14 * 60) return { status: 'invalid', observedAt: null, ageSeconds: null }
  const epoch = base - offset * 60_000
  const ageSeconds = Math.round((nowMs - epoch) / 1000)
  const status = ageSeconds < 0 ? 'future' : ageSeconds <= 120 ? 'fresh' : ageSeconds <= 300 ? 'delayed' : 'stale'
  return { status, observedAt: new Date(epoch).toISOString(), ageSeconds }
}

export function normalizeFullPlate(value: string): string {
  return value.normalize('NFKC').replace(/[^0-9A-Za-z가-힣]/g, '').toUpperCase()
}

const norm = (value: string) => value.normalize('NFKC').replace(/[\s()\[\]·._-]/g, '').toLowerCase()
export interface RouteEvidence { regionCode: string; number: string; start: string; end: string; stopIds: string[] }

export function assessRouteMatch(gbis: RouteEvidence, precision: RouteEvidence): EvidenceLevel {
  if (gbis.regionCode !== precision.regionCode || norm(gbis.number) !== norm(precision.number)) return 'unverified'
  if (norm(gbis.start) !== norm(precision.start) || norm(gbis.end) !== norm(precision.end)) return 'candidate'
  if (gbis.stopIds.length < 3 || precision.stopIds.length < 3 || gbis.stopIds.length !== precision.stopIds.length) return 'candidate'
  return gbis.stopIds.every((id, index) => id === precision.stopIds[index]) ? 'verified' : 'candidate'
}

export function distanceToPathMeters(point: Coordinates, path: Coordinates[]): number {
  if (path.length < 2) return Infinity
  const scale = Math.cos(point.latitude * Math.PI / 180)
  let nearest = Infinity
  for (let i = 0; i < path.length - 1; i++) {
    const a = path[i], b = path[i + 1]
    const dx = (b.longitude - a.longitude) * scale * 111_320
    const dy = (b.latitude - a.latitude) * 111_320
    const px = (point.longitude - a.longitude) * scale * 111_320
    const py = (point.latitude - a.latitude) * 111_320
    const ratio = Math.max(0, Math.min(1, (px * dx + py * dy) / (dx * dx + dy * dy || 1)))
    nearest = Math.min(nearest, Math.hypot(px - dx * ratio, py - dy * ratio))
  }
  return nearest
}

/** A verified vehicle needs a fresh timestamp, unique full plate, and route/section agreement. */
export function assessVehicleMatch(input: { fix: PrecisionFix; gbisPlate: string; routeEvidence: EvidenceLevel;
  matchingGbisPlates: number; matchingPrecisionPlates: number; routePath: Coordinates[]; currentSection: Coordinates[] | null;
  nowMs: number; confirmedOffsetMinutes: number | null }): EvidenceLevel {
  const plate = normalizeFullPlate(input.gbisPlate)
  // A matching suffix alone is not a unique registration number.
  if (!/^(?:[가-힣]{2,})?\d{2,3}[가-힣]\d{4}$/.test(plate) ||
      plate !== normalizeFullPlate(input.fix.vehicleNumber) || input.routeEvidence === 'unverified') return 'unverified'
  if (input.routeEvidence !== 'verified' || input.matchingGbisPlates !== 1 || input.matchingPrecisionPlates !== 1) return 'candidate'
  const age = assessFixAge(input.fix.collectedAtRaw, input.nowMs, input.confirmedOffsetMinutes)
  if (age.status !== 'fresh') return 'candidate'
  if (distanceToPathMeters(input.fix.position, input.routePath) > 100) return 'candidate'
  if (!input.currentSection || distanceToPathMeters(input.fix.position, input.currentSection) > 150) return 'candidate'
  return 'verified'
}
