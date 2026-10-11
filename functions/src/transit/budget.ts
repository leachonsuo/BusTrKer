import { randomUUID } from 'node:crypto'
import { mkdir, open, readFile, rename, unlink, writeFile } from 'node:fs/promises'
import { dirname, resolve } from 'node:path'
import { setTimeout as delay } from 'node:timers/promises'
import { recordMetric } from './metrics'
import { createFirestoreBudgetStore } from './firestore-budget'

export type GbisService = 'routes' | 'stations' | 'locations' | 'arrivals'
export const APPROVED_DAILY_LIMIT = 1_000
export const DEFAULT_INTERNAL_LIMIT = 800
export const ROLLING_WINDOW_MS = 24 * 60 * 60 * 1_000

const apiServices: Record<string, GbisService> = {
  getBusRouteListv2: 'routes',
  getBusRouteInfoItemv2: 'routes',
  getBusRouteLineListv2: 'routes',
  getBusRouteStationListv2: 'routes',
  getBusStationAroundListv2: 'stations',
  getBusLocationListv2: 'locations',
  getBusArrivalListv2: 'arrivals',
}
const limitVariables: Record<GbisService, string> = {
  routes: 'GBIS_BUDGET_ROUTES', stations: 'GBIS_BUDGET_STATIONS',
  locations: 'GBIS_BUDGET_LOCATIONS', arrivals: 'GBIS_BUDGET_ARRIVALS',
}
const services: GbisService[] = ['routes', 'stations', 'locations', 'arrivals']
// Keep two sequential budget + 8s upstream attempts below Hosting's 60s limit.
const RESERVATION_TIMEOUT_MS = 12_000
export function serviceForGbisApi(api: string): GbisService | null { return apiServices[api] ?? null }

export interface BudgetReservation { allowed: boolean; used: number; limit: number }
export interface BudgetStore { reserve(service: GbisService, limit: number): Promise<BudgetReservation> }
interface Ledger { version: 1; lastSeenAt: number; attempts: Record<GbisService, number[]> }

function emptyLedger(): Ledger {
  return { version: 1, lastSeenAt: 0, attempts: { routes: [], stations: [], locations: [], arrivals: [] } }
}

function validLedger(value: unknown): value is Ledger {
  if (!value || typeof value !== 'object' || Array.isArray(value)) return false
  const item = value as Partial<Ledger>
  return item.version === 1 && Number.isSafeInteger(item.lastSeenAt) && Number(item.lastSeenAt) >= 0 &&
    !!item.attempts && services.every((service) => Array.isArray(item.attempts?.[service]) &&
      item.attempts[service].every((time) => Number.isSafeInteger(time) && time > 0 && time <= item.lastSeenAt!))
}

function applyReservation(ledger: Ledger, service: GbisService, limit: number, now: number): BudgetReservation {
  if (!Number.isSafeInteger(now) || now <= 0 || now < ledger.lastSeenAt) throw new Error('budget clock invalid or moved backward')
  if (!Number.isSafeInteger(limit) || limit < 1 || limit > APPROVED_DAILY_LIMIT) throw new Error('budget limit invalid')
  const active = ledger.attempts[service].filter((time) => time > now - ROLLING_WINDOW_MS)
  ledger.attempts[service] = active
  ledger.lastSeenAt = now
  if (active.length >= limit) return { allowed: false, used: active.length, limit }
  active.push(now)
  return { allowed: true, used: active.length, limit }
}

/** Test-only shared state. This is never selected automatically in production. */
export class MemoryBudgetStore implements BudgetStore {
  constructor(private readonly ledger: Ledger = emptyLedger(), private readonly now: () => number = Date.now) {}
  async reserve(service: GbisService, limit: number): Promise<BudgetReservation> {
    // No await before mutation: callers sharing this store cannot approve the same slot twice.
    return applyReservation(this.ledger, service, limit, this.now())
  }
}

/** Emulator-only durable fixture. An exclusive lock serializes local processes; a stale lock fails closed. */
export class FileBudgetStore implements BudgetStore {
  constructor(private readonly file: string, private readonly now: () => number = Date.now) {}

  async reserve(service: GbisService, limit: number): Promise<BudgetReservation> {
    const lockPath = `${this.file}.lock`
    await mkdir(dirname(this.file), { recursive: true })
    let lock: Awaited<ReturnType<typeof open>> | undefined
    const deadline = Date.now() + 2_000
    while (!lock) {
      try { lock = await open(lockPath, 'wx') } catch (error) {
        if ((error as NodeJS.ErrnoException).code !== 'EEXIST' || Date.now() >= deadline) throw error
        await delay(15)
      }
    }
    try {
      let ledger: Ledger
      try {
        const raw: unknown = JSON.parse(await readFile(this.file, 'utf8'))
        if (!validLedger(raw)) throw new Error('budget ledger invalid')
        ledger = raw
      } catch (error) {
        if ((error as NodeJS.ErrnoException).code !== 'ENOENT') throw error
        ledger = emptyLedger()
      }
      const result = applyReservation(ledger, service, limit, this.now())
      const temporary = `${this.file}.${randomUUID()}.tmp`
      try {
        await writeFile(temporary, JSON.stringify(ledger), { flag: 'wx' })
        await rename(temporary, this.file)
      } catch (error) {
        await unlink(temporary).catch(() => undefined)
        throw error
      }
      return result
    } finally {
      await lock.close()
      await unlink(lockPath).catch(() => undefined)
    }
  }
}

export type BudgetDecision =
  | { kind: 'reserved'; service: GbisService; used: number; limit: number }
  | { kind: 'exhausted'; service: GbisService; used: number; limit: number }
  | { kind: 'unavailable'; service: GbisService | 'unknown' }

let testStore: BudgetStore | null = null
let emulatorStore: BudgetStore | null = null
let firestoreStore: BudgetStore | null = null
const unavailableWarnings = new Set<string>()

export function setBudgetStoreForTests(store: BudgetStore | null): void { testStore = store }

function configuredLimit(service: GbisService): number {
  const raw = process.env[limitVariables[service]]
  if (raw === undefined) return DEFAULT_INTERNAL_LIMIT
  if (!/^\d{1,4}$/.test(raw)) throw new Error('budget limit configuration invalid')
  const limit = Number(raw)
  if (limit < 1 || limit > APPROVED_DAILY_LIMIT) throw new Error('budget limit configuration outside approved range')
  return limit
}

function selectedStore(): BudgetStore | null {
  if (testStore) return testStore
  const mode = process.env.GBIS_BUDGET_STORE
  if (mode === 'firestore') {
    if (!firestoreStore) firestoreStore = createFirestoreBudgetStore()
    return firestoreStore
  }
  if (mode !== undefined && mode !== 'file') return null
  if (process.env.FUNCTIONS_EMULATOR !== 'true') return null
  if (!emulatorStore) emulatorStore = new FileBudgetStore(resolve(__dirname, '../../.budget.local.json'))
  return emulatorStore
}

export async function reserveGbisAttempt(api: string): Promise<BudgetDecision> {
  const service = serviceForGbisApi(api)
  if (!service) return { kind: 'unavailable', service: 'unknown' } // New APIs must be mapped explicitly.
  try {
    const store = selectedStore()
    if (!store) throw new Error('shared budget store not configured')
    const limit = configuredLimit(service)
    let timer: NodeJS.Timeout | undefined
    let result: BudgetReservation
    try {
      result = await Promise.race([
        store.reserve(service, limit),
        new Promise<BudgetReservation>((_, reject) => {
          timer = setTimeout(() => reject(new Error('budget reservation timed out')), RESERVATION_TIMEOUT_MS)
        }),
      ])
    } finally { if (timer) clearTimeout(timer) }
    if (result.limit !== limit || !Number.isSafeInteger(result.used) || result.used < 0 ||
        typeof result.allowed !== 'boolean' || (result.allowed && (result.used < 1 || result.used > limit)) ||
        (!result.allowed && result.used < limit)) throw new Error('budget reservation result invalid')
    recordMetric(result.allowed ? 'budgetReserved' : 'budgetDenied', service)
    if (result.allowed && (result.used === Math.ceil(result.limit * 0.9) || result.used === result.limit)) {
      console.warn('GBIS_BUDGET_NEAR_LIMIT', { service, used: result.used, limit: result.limit })
    }
    return { kind: result.allowed ? 'reserved' : 'exhausted', service, used: result.used, limit: result.limit }
  } catch {
    recordMetric('budgetUnavailable', service)
    if (!unavailableWarnings.has(service)) {
      unavailableWarnings.add(service)
      console.warn('GBIS_BUDGET_UNAVAILABLE', { service })
    }
    return { kind: 'unavailable', service }
  }
}
