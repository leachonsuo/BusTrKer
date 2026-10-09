type CounterName = 'mapCreated' | 'mapDisposed' | 'polylineCreated' | 'polylineRemoved' |
  'overlayCreated' | 'overlayRemoved' | 'markerCreated' | 'markerRemoved' |
  'listenerAdded' | 'listenerRemoved'
type TimingName = 'routeUpdate' | 'sectionUpdate' | 'arrowUpdate'
type Metrics = { counters: Record<CounterName, number>; timings: Record<TimingName, number[]> }

declare global { interface Window { __BUS_TRACKER_MAP_METRICS__?: Metrics } }

function metrics(): Metrics | null {
  if (!import.meta.env.DEV) return null
  return window.__BUS_TRACKER_MAP_METRICS__ ??= {
    counters: { mapCreated: 0, mapDisposed: 0, polylineCreated: 0, polylineRemoved: 0,
      overlayCreated: 0, overlayRemoved: 0, markerCreated: 0, markerRemoved: 0,
      listenerAdded: 0, listenerRemoved: 0 },
    timings: { routeUpdate: [], sectionUpdate: [], arrowUpdate: [] },
  }
}

export function countMap(name: CounterName, count = 1): void {
  const value = metrics()
  if (value) value.counters[name] += count
}

export function timeMap(name: TimingName, started: number): void {
  const value = metrics()
  if (!value) return
  const samples = value.timings[name]
  samples.push(Math.round((performance.now() - started) * 10) / 10)
  if (samples.length > 128) samples.shift()
}
