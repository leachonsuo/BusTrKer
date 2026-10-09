import { recordMetric } from './metrics'

interface Entry<T> { expiresAt: number; value: T }

const entries = new Map<string, Entry<unknown>>()
const pending = new Map<string, Promise<unknown>>()
const MAX_ENTRIES = 300

function metricName(key: string): string { return key.split(':')[1] ?? 'unknown' }

export function cacheSizes(): { entries: number; pending: number } { return { entries: entries.size, pending: pending.size } }

export async function cached<T>(key: string, ttlMs: number, load: () => Promise<T>): Promise<T> {
  const name = metricName(key)
  const previous = entries.get(key)
  if (previous && previous.expiresAt > Date.now()) {
    // Keep frequently used routes in the bounded cache when other keys arrive.
    entries.delete(key)
    entries.set(key, previous)
    recordMetric('cacheHit', name)
    return previous.value as T
  }
  if (previous) entries.delete(key)
  const existing = pending.get(key)
  if (existing) { recordMetric('cacheJoin', name); return existing as Promise<T> }

  recordMetric('cacheMiss', name)
  const task = Promise.resolve().then(load).then((value) => {
    entries.set(key, { value, expiresAt: Date.now() + ttlMs })
    if (entries.size > MAX_ENTRIES) {
      for (const [candidate, entry] of entries) if (entry.expiresAt <= Date.now()) entries.delete(candidate)
    }
    while (entries.size > MAX_ENTRIES) {
      const oldest = entries.keys().next().value
      if (oldest) entries.delete(oldest)
      else break
    }
    return value
  }).finally(() => pending.delete(key))
  pending.set(key, task)
  return task
}
