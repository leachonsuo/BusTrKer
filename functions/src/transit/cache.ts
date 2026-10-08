interface Entry<T> { expiresAt: number; value: T }

const entries = new Map<string, Entry<unknown>>()
const pending = new Map<string, Promise<unknown>>()

export async function cached<T>(key: string, ttlMs: number, load: () => Promise<T>): Promise<T> {
  const previous = entries.get(key)
  if (previous && previous.expiresAt > Date.now()) return previous.value as T
  const existing = pending.get(key)
  if (existing) return existing as Promise<T>

  const task = load().then((value) => {
    entries.set(key, { value, expiresAt: Date.now() + ttlMs })
    if (entries.size > 300) {
      const oldest = entries.keys().next().value
      if (oldest) entries.delete(oldest)
    }
    return value
  }).finally(() => pending.delete(key))
  pending.set(key, task)
  return task
}
