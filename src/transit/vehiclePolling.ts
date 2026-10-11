import type { TransitId, VehiclePositionsResult } from './api'

export interface TrackedRoute { key: string; id: TransitId; visible: boolean }
export type PollingTrigger = 'route_added' | 'automatic_60s' | 'manual_refresh' | 'visibility_resume' |
  'visibility_pause' | 'network_resume' | 'offline' | 'retry_backoff'
export type PollingUpdate = { status: 'loading'; trigger: PollingTrigger } |
  { status: 'ready'; data: VehiclePositionsResult; trigger: PollingTrigger } |
  { status: 'error'; message: string; trigger: PollingTrigger; httpStatus: number | null } | null

interface Runtime {
  route: TrackedRoute
  controller: AbortController | null
  timer: number | null
  data: VehiclePositionsResult | null
  failures: number
  blocked: boolean
  rateLimitedUntil: number
  lastRequestAt: number
  nextDueAt: number
}

export interface RefreshResult { started: number; busy: number; recent: number; rateLimited: number; unavailable: boolean }
type Request = (id: TransitId, signal: AbortSignal) => Promise<VehiclePositionsResult>

/** One timer and at most one browser request per visible route. No cross-route restarts. */
export class VehiclePollingController {
  private readonly entries = new Map<string, Runtime>()
  private visible = true
  private online = true

  constructor(
    private readonly request: Request,
    private readonly update: (key: string, event: PollingUpdate) => void,
    private readonly now: () => number = () => Date.now(),
    private readonly setTimer: (callback: () => void, delay: number) => number = (callback, delay) => window.setTimeout(callback, delay),
    private readonly clearTimer: (timer: number) => void = (timer) => window.clearTimeout(timer),
    private readonly random: () => number = () => Math.random(),
  ) {}

  setRoutes(routes: TrackedRoute[]): void {
    const selected = new Map(routes.filter((route) => route.visible).map((route) => [route.key, route]))
    for (const [key, entry] of this.entries) {
      if (selected.has(key)) continue
      this.stop(entry)
      this.entries.delete(key)
      this.update(key, null)
    }
    for (const [key, route] of selected) {
      const existing = this.entries.get(key)
      if (existing) { existing.route = route; continue }
      const entry: Runtime = { route, controller: null, timer: null, data: null, failures: 0, blocked: false,
        rateLimitedUntil: 0, lastRequestAt: 0, nextDueAt: 0 }
      this.entries.set(key, entry)
      if (this.visible && this.online) this.schedule(entry, 0, 'route_added')
    }
  }

  setVisible(visible: boolean): void {
    if (this.visible === visible) return
    this.visible = visible
    if (!visible) {
      for (const entry of this.entries.values()) {
        this.stop(entry)
        if (entry.data) this.update(entry.route.key, { status: 'ready', data: entry.data, trigger: 'visibility_pause' })
        else this.update(entry.route.key, null)
      }
      return
    }
    if (!this.online) return
    for (const entry of this.entries.values()) {
      if (entry.blocked) continue
      this.schedule(entry, Math.max(0, entry.nextDueAt - this.now()), 'visibility_resume')
    }
  }

  setOnline(online: boolean): void {
    if (this.online === online) return
    this.online = online
    if (!online) {
      for (const entry of this.entries.values()) {
        this.stop(entry)
        entry.data = null
        this.update(entry.route.key, { status: 'error', message: '네트워크 연결이 끊겼습니다. 연결되면 다시 조회합니다.', trigger: 'offline', httpStatus: null })
      }
      return
    }
    if (!this.visible) return
    for (const entry of this.entries.values()) {
      if (entry.blocked) continue
      const due = entry.data ? entry.nextDueAt : Math.max(entry.rateLimitedUntil, entry.lastRequestAt + 10_000)
      this.schedule(entry, Math.max(0, due - this.now()), 'network_resume')
    }
  }

  refresh(): RefreshResult {
    const result: RefreshResult = { started: 0, busy: 0, recent: 0, rateLimited: 0, unavailable: !this.visible || !this.online }
    if (!this.visible || !this.online) return result
    for (const entry of this.entries.values()) {
      if (entry.controller) { result.busy++; continue }
      if (this.now() < entry.rateLimitedUntil) { result.rateLimited++; continue }
      if (entry.lastRequestAt && this.now() - entry.lastRequestAt < 10_000) { result.recent++; continue }
      this.start(entry, 'manual_refresh')
      result.started++
    }
    return result
  }

  private stop(entry: Runtime): void {
    if (entry.timer !== null) this.clearTimer(entry.timer)
    entry.timer = null
    entry.controller?.abort()
    entry.controller = null
  }

  private schedule(entry: Runtime, delay: number, trigger: PollingTrigger): void {
    if (!this.visible || !this.online || this.entries.get(entry.route.key) !== entry || entry.blocked) return
    if (entry.timer !== null) this.clearTimer(entry.timer)
    entry.nextDueAt = this.now() + delay
    entry.timer = this.setTimer(() => { entry.timer = null; this.start(entry, trigger) }, delay)
  }

  private start(entry: Runtime, trigger: PollingTrigger): void {
    if (!this.visible || !this.online || this.entries.get(entry.route.key) !== entry || entry.controller) return
    if (entry.timer !== null) this.clearTimer(entry.timer)
    entry.timer = null
    const controller = new AbortController()
    entry.controller = controller
    entry.lastRequestAt = this.now()
    entry.blocked = false
    this.update(entry.route.key, { status: 'loading', trigger })
    void this.request(entry.route.id, controller.signal).then((data) => {
      if (controller.signal.aborted || this.entries.get(entry.route.key) !== entry || !this.visible || !this.online) return
      entry.data = data
      entry.failures = 0
      entry.rateLimitedUntil = 0
      this.update(entry.route.key, { status: 'ready', data, trigger })
      this.schedule(entry, 60_000, 'automatic_60s')
    }).catch((error: unknown) => {
      if (controller.signal.aborted || this.entries.get(entry.route.key) !== entry || !this.visible || !this.online) return
      entry.data = null
      entry.failures = Math.min(entry.failures + 1, 2)
      const status = error && typeof error === 'object' && 'status' in error ? Number(error.status) : 0
      const code = error && typeof error === 'object' && 'code' in error ? String(error.code) : ''
      const message = error instanceof Error ? error.message : '차량 조회 실패'
      this.update(entry.route.key, { status: 'error', message, trigger, httpStatus: status || null })
      if (status === 400 || status === 503 || code === 'UPSTREAM_AUTH_ERROR' || code === 'INTERNAL_BUDGET_EXHAUSTED') {
        entry.blocked = true
        return
      }
      // Existing 120/180 second policy, with at most ten seconds of per-tab jitter.
      const delay = Math.min(180_000, 60_000 * (entry.failures + 1)) + Math.floor(this.random() * 10_000)
      if (status === 429) entry.rateLimitedUntil = this.now() + delay
      this.schedule(entry, delay, 'retry_backoff')
    }).finally(() => {
      if (entry.controller === controller) entry.controller = null
    })
  }
}
