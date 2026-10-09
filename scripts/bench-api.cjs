// Bounded emulator-only concurrency check. Prints aggregates; never prints keys, IDs or response bodies.
const base = 'http://localhost:5000'
const routeId = process.argv[2] ?? '219000001'
if (!/^\d{1,20}$/.test(routeId)) throw new Error('A numeric GBIS route ID is required')

async function readMetrics() {
  const response = await fetch(`${base}/api/_metrics`, { signal: AbortSignal.timeout(5000) })
  if (!response.ok) throw new Error('Start the local Firebase Functions emulator to enable diagnostics')
  return response.json()
}

async function main() {
  const before = await readMetrics()
  const start = performance.now()
  const responses = await Promise.all(Array.from({ length: 10 }, () =>
    fetch(`${base}/api/routes/${routeId}/vehicles`, { signal: AbortSignal.timeout(20000) })))
  // Consume responses without printing any vehicle record or upstream body.
  await Promise.all(responses.map((response) => response.arrayBuffer()))
  const after = await readMetrics()
  const sameInstance = before.instanceId === after.instanceId
  const delta = sameInstance ? {} : null
  if (delta) for (const [name, value] of Object.entries(after.operations)) {
    const difference = value.count - (before.operations[name]?.count ?? 0)
    if (difference > 0) delta[name] = difference
  }
  process.stdout.write(JSON.stringify({ requests: responses.length, statusCounts: responses.reduce((counts, response) => {
    counts[response.status] = (counts[response.status] ?? 0) + 1
    return counts
  }, {}), elapsedMs: Math.round(performance.now() - start), sameMetricsInstance: sameInstance, metricDeltas: delta,
  cache: after.cache, vehicleHttp: after.operations['http:route-vehicles'] ?? null,
  vehicleUpstream: after.operations['upstream:getBusLocationListv2'] ?? null }) + '\n')
}

main().catch((error) => { process.stderr.write(`Benchmark failed: ${error.message}\n`); process.exitCode = 1 })
