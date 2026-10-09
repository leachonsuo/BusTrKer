type Operation = 'http' | 'httpError' | 'upstream' | 'cacheHit' | 'cacheMiss' | 'cacheJoin' | 'upstreamError'

interface Counter { count: number; totalMs: number; samples: number[] }
const enabled = process.env.FUNCTIONS_EMULATOR === 'true' || process.env.BUSTRACKER_TEST_METRICS === '1'
const counters = new Map<string, Counter>()
const SAMPLE_LIMIT = 128

/** Aggregate diagnostics only: names are fixed endpoint labels, never IDs or URLs. */
export function recordMetric(operation: Operation, name: string, durationMs?: number): void {
  if (!enabled) return
  const key = `${operation}:${name}`
  let counter = counters.get(key)
  if (!counter) { counter = { count: 0, totalMs: 0, samples: [] }; counters.set(key, counter) }
  counter.count++
  if (durationMs !== undefined && Number.isFinite(durationMs)) {
    counter.totalMs += durationMs
    counter.samples.push(durationMs)
    if (counter.samples.length > SAMPLE_LIMIT) counter.samples.shift()
  }
}

export function metricsSnapshot(): Record<string, { count: number; averageMs: number | null; p50Ms: number | null; p95Ms: number | null }> {
  const result: Record<string, { count: number; averageMs: number | null; p50Ms: number | null; p95Ms: number | null }> = {}
  for (const [name, counter] of counters) {
    const sorted = [...counter.samples].sort((a, b) => a - b)
    const at = (fraction: number) => sorted.length ? Math.round(sorted[Math.ceil(sorted.length * fraction) - 1]) : null
    result[name] = { count: counter.count, averageMs: sorted.length ? Math.round(counter.totalMs / counter.count) : null,
      p50Ms: at(0.5), p95Ms: at(0.95) }
  }
  return result
}

export function resetMetricsForTests(): void { if (enabled) counters.clear() }
