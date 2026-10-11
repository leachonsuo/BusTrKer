import { randomUUID } from 'node:crypto'
import { setTimeout as delay } from 'node:timers/promises'
import { getApps, initializeApp } from 'firebase-admin/app'
import { getFirestore, type Firestore } from 'firebase-admin/firestore'
import { APPROVED_DAILY_LIMIT, ROLLING_WINDOW_MS, type BudgetReservation, type BudgetStore, type GbisService } from './budget'

interface Attempt { id: string; at: number }
interface ServiceLedger { version: 1; lastSeenAt: number; attempts: Attempt[] }
const COLLECTION = 'bustracker_gbis_budget_v1'
const UUID = /^[0-9a-f]{8}-[0-9a-f]{4}-[1-8][0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}$/i

function ledgerFrom(value: unknown): ServiceLedger {
  if (!value || typeof value !== 'object' || Array.isArray(value)) throw new Error('budget document invalid')
  const item = value as Partial<ServiceLedger>
  if (item.version !== 1 || !Number.isSafeInteger(item.lastSeenAt) || Number(item.lastSeenAt) < 0 ||
      !Array.isArray(item.attempts) || item.attempts.length > APPROVED_DAILY_LIMIT) throw new Error('budget document invalid')
  const ids = new Set<string>()
  let previous = 0
  for (const attempt of item.attempts) {
    if (!attempt || typeof attempt !== 'object' || !UUID.test(attempt.id) || ids.has(attempt.id) ||
        !Number.isSafeInteger(attempt.at) || attempt.at <= 0 || attempt.at > item.lastSeenAt! || attempt.at < previous) {
      throw new Error('budget attempts invalid')
    }
    ids.add(attempt.id)
    previous = attempt.at
  }
  return item as ServiceLedger
}

function retryableContention(error: unknown): boolean {
  const code = (error as { code?: unknown } | null)?.code
  return code === 10 || code === 'ABORTED' || code === 'aborted'
}

/** One service document contains at most 1,000 recent UUID/timestamp pairs. */
export class FirestoreBudgetStore implements BudgetStore {
  private readonly deniedUntil = new Map<string, { observedAt: number; until: number; used: number }>()

  constructor(
    private readonly db: Firestore,
    private readonly now?: () => number,
    private readonly collection = COLLECTION,
  ) {}

  async reserve(service: GbisService, limit: number): Promise<BudgetReservation> {
    if (!Number.isSafeInteger(limit) || limit < 1 || limit > APPROVED_DAILY_LIMIT) throw new Error('budget limit invalid')
    const key = `${service}:${limit}`
    const start = this.now?.() ?? Date.now()
    if (!Number.isSafeInteger(start) || start <= 0) throw new Error('budget clock invalid')
    const denial = this.deniedUntil.get(key)
    // A local denial can only refuse traffic; it can never grant a global slot.
    if (denial && start >= denial.observedAt && start < denial.until) return { allowed: false, used: denial.used, limit }
    const requestId = randomUUID() // stable across transaction replays and outer contention retries
    const ref = this.db.collection(this.collection).doc(service)
    for (let attempt = 0; attempt < 8; attempt++) {
      try {
        const result = await this.db.runTransaction(async (transaction) => {
          const snapshot = await transaction.get(ref)
          const ledger = snapshot.exists ? ledgerFrom(snapshot.data()) : { version: 1 as const, lastSeenAt: 0, attempts: [] as Attempt[] }
          // In production the Firestore read timestamp is the shared clock across instances.
          // The injected clock is reserved for deterministic emulator boundary tests.
          const timestamp = this.now?.() ?? snapshot.readTime?.toMillis()
          if (!Number.isSafeInteger(timestamp) || timestamp <= 0 || timestamp < ledger.lastSeenAt) {
            throw new Error('budget clock invalid or moved backward')
          }
          const active = ledger.attempts.filter((item) => item.at > timestamp - ROLLING_WINDOW_MS)
          // A lost acknowledgement after commit must not reserve a second slot.
          if (active.some((item) => item.id === requestId)) return { allowed: true, used: active.length, limit, nextAt: 0 }
          if (active.length >= limit) {
            return { allowed: false, used: active.length, limit, nextAt: active[0].at + ROLLING_WINDOW_MS }
          }
          active.push({ id: requestId, at: timestamp })
          transaction.set(ref, { version: 1, lastSeenAt: timestamp, attempts: active } satisfies ServiceLedger)
          return { allowed: true, used: active.length, limit, nextAt: 0 }
        }, { maxAttempts: 10 })
        if (!result.allowed) {
          const observedAt = this.now?.() ?? Date.now()
          this.deniedUntil.set(key, { observedAt, until: Math.min(result.nextAt, observedAt + 10_000), used: result.used })
        } else this.deniedUntil.delete(key)
        return { allowed: result.allowed, used: result.used, limit }
      } catch (error) {
        if (!retryableContention(error) || attempt === 7) throw error
        await delay(Math.min(250, 10 * (attempt + 1) ** 2) + Math.floor(Math.random() * 20))
      }
    }
    throw new Error('budget transaction unavailable')
  }
}

/** Initialization is deliberately lazy; file mode never opens Firestore. */
export function createFirestoreBudgetStore(): FirestoreBudgetStore {
  const emulator = process.env.FUNCTIONS_EMULATOR === 'true'
  const host = process.env.FIRESTORE_EMULATOR_HOST
  const projectId = process.env.GCLOUD_PROJECT || process.env.GCP_PROJECT
  if (emulator) {
    if (!host || !/^(127\.0\.0\.1|localhost):\d+$/.test(host) || !projectId?.startsWith('demo-')) {
      throw new Error('Firestore emulator requires a local host and demo project')
    }
  } else if (host || !projectId || projectId.startsWith('demo-')) {
    throw new Error('production Firestore project configuration invalid')
  }
  const app = getApps()[0] ?? initializeApp({ projectId })
  if (app.options.projectId !== projectId) throw new Error('Firestore project mismatch')
  return new FirestoreBudgetStore(getFirestore(app))
}
