// Offline, normalized GBIS route fixture diagnostic. Never reads credentials or calls an API.
const fs = require('node:fs')
const path = require('node:path')
const ts = require('typescript')

const METERS = 111_320
const STOP_LIMIT = 35

function loadSplitter() {
  const source = fs.readFileSync(path.join(__dirname, '../src/transit/routeDirections.ts'), 'utf8')
  const code = ts.transpileModule(source, { compilerOptions: {
    module: ts.ModuleKind.CommonJS, target: ts.ScriptTarget.ES2022,
  } }).outputText
  const module = { exports: {} }
  new Function('module', 'exports', 'require', code)(module, module.exports, (name) =>
    name === './api' ? { transitKey: (id) => `${id.provider}:${id.regionCode}:${id.value}` } : require(name))
  return module.exports.splitRouteDirections
}

function project(position, points, from, to) {
  const cosine = Math.cos(position.latitude * Math.PI / 180)
  const candidates = []
  let along = 0
  for (let index = from; index < to; index++) {
    const a = points[index], b = points[index + 1]
    const dx = (b.longitude - a.longitude) * METERS * cosine
    const dy = (b.latitude - a.latitude) * METERS
    const px = (position.longitude - a.longitude) * METERS * cosine
    const py = (position.latitude - a.latitude) * METERS
    const length = Math.hypot(dx, dy)
    const fraction = Math.max(0, Math.min(1, (px * dx + py * dy) / (dx * dx + dy * dy || 1)))
    candidates.push({ index: index + fraction, along: along + length * fraction,
      error: Math.hypot(px - dx * fraction, py - dy * fraction) })
    along += length
  }
  return candidates.sort((a, b) => a.error - b.error)
}

function candidateSummary(candidate) {
  return { index: Number(candidate.index.toFixed(3)), errorMeters: Number(candidate.error.toFixed(2)),
    alongMeters: Number(candidate.along.toFixed(1)) }
}

function scan(stops, points, from, to) {
  let previous = -Infinity
  let previousStop = null
  for (const stop of stops) {
    const candidates = project(stop.position, points, from, to)
    const best = candidates[0]
    const ambiguous = best && candidates.some((candidate) => candidate.error <= best.error + 10 &&
      Math.abs(candidate.along - best.along) > 80)
    const code = !best || best.error > STOP_LIMIT ? 'STOP_TOO_FAR' :
      best.index <= previous + 0.05 ? 'STOP_SHAPE_SEQUENCE_MISMATCH' :
      ambiguous ? 'AMBIGUOUS_SHAPE_MATCH' : null
    if (code) {
      const withinLimit = candidates.filter((candidate) => candidate.error <= STOP_LIMIT)
      return { code, stopSequence: stop.sequence, stopId: stop.id.value, stopName: stop.name,
        previousStopSequence: previousStop?.sequence ?? null,
        previousShapeIndex: Number.isFinite(previous) ? Number(previous.toFixed(3)) : null,
        chosen: best ? candidateSummary(best) : null,
        candidates: withinLimit.slice(0, 10).map(candidateSummary),
        forwardCandidates: withinLimit.filter((candidate) => candidate.index > previous + 0.05)
          .slice(0, 10).map(candidateSummary),
        nextStopSequence: stops.find((item) => item.sequence === stop.sequence + 1)?.sequence ?? null }
    }
    previous = best.index
    previousStop = stop
  }
  return null
}

function candidatePaths(stops, points, from, to) {
  const nearestByStop = []
  const rows = stops.map((stop) => {
    const all = project(stop.position, points, from, to)
    nearestByStop.push(all[0] ?? null)
    if (!all.length) return []
    const limit = Math.min(STOP_LIMIT, all[0].error + 10)
    return all.filter((candidate) => candidate.error <= limit)
      .sort((a, b) => a.index - b.index)
      .filter((candidate, index, list) => index === 0 || candidate.index > list[index - 1].index + 0.05)
  })
  const forward = rows.map(() => [])
  const backward = rows.map(() => [])
  for (let stopIndex = 0; stopIndex < rows.length; stopIndex++) {
    forward[stopIndex] = rows[stopIndex].map((candidate) => stopIndex === 0 ||
      rows[stopIndex - 1].some((previous, index) => forward[stopIndex - 1][index] && candidate.index > previous.index + 0.05))
  }
  for (let stopIndex = rows.length - 1; stopIndex >= 0; stopIndex--) {
    backward[stopIndex] = rows[stopIndex].map((candidate) => stopIndex === rows.length - 1 ||
      rows[stopIndex + 1].some((next, index) => backward[stopIndex + 1][index] && next.index > candidate.index + 0.05))
  }
  const ambiguities = []
  for (let stopIndex = 0; stopIndex < rows.length; stopIndex++) {
    const viable = rows[stopIndex].filter((_, index) => forward[stopIndex][index] && backward[stopIndex][index])
    let group = []
    const groups = []
    for (const candidate of viable) {
      if (group.length && candidate.along - group.at(-1).along > 80) {
        groups.push(group)
        group = []
      }
      group.push(candidate)
    }
    if (group.length) groups.push(group)
    if (groups.length > 1) ambiguities.push({ sequence: stops[stopIndex].sequence,
      visits: groups.map((items) => candidateSummary(items.reduce((a, b) => a.error < b.error ? a : b))) })
  }
  const firstUnreachableIndex = forward.findIndex((row) => !row.some(Boolean))
  return { completePathExists: forward.at(-1)?.some(Boolean) ?? false,
    missingCandidateSequences: rows.flatMap((row, index) => row.length ? [] : [stops[index].sequence]),
    firstUnreachable: firstUnreachableIndex < 0 ? null : {
      sequence: stops[firstUnreachableIndex].sequence,
      nearest: nearestByStop[firstUnreachableIndex] ? candidateSummary(nearestByStop[firstUnreachableIndex]) : null,
      previousSequence: stops[firstUnreachableIndex - 1]?.sequence ?? null,
      previousReachableIndices: firstUnreachableIndex > 0 ? rows[firstUnreachableIndex - 1]
        .filter((_, index) => forward[firstUnreachableIndex - 1][index]).slice(0, 12).map(candidateSummary) : [],
      candidates: rows[firstUnreachableIndex].slice(0, 12).map(candidateSummary) },
    ambiguousVisits: ambiguities.slice(0, 12), ambiguousVisitCount: ambiguities.length }
}

function analyze(fixture) {
  const shape = fixture.shape?.shape ?? fixture.shape
  const route = fixture.detail?.route ?? fixture.route ?? (shape?.routeId ? { id: shape.routeId } : null)
  const stops = fixture.stops?.stops ?? fixture.stops
  if (!route?.id?.value || !shape?.points || !Array.isArray(stops)) throw new Error('Normalized route, shape, and stops are required')
  const ordered = [...stops].sort((a, b) => a.sequence - b.sequence)
  const turns = ordered.filter((stop) => stop.turnYn === true)
  const split = loadSplitter()(route, shape, stops)
  const report = { routeId: route.id.value, name: route.name ?? null,
    stopCount: stops.length, shapePointCount: shape.points.length, turnCount: turns.length,
    splitSucceeded: !!split.directions, splitCode: split.code, splitReason: split.reason }
  if (turns.length !== 1) return report
  const turnAt = ordered.indexOf(turns[0])
  const turnCandidates = project(turns[0].position, shape.points, 0, shape.points.length - 1)
  const nearest = turnCandidates[0]
  const splitIndex = Math.ceil(nearest.index)
  report.turn = { sequence: turns[0].sequence, stopId: turns[0].id.value,
    nearest: candidateSummary(nearest), splitIndex,
    ambiguousCandidates: turnCandidates.filter((candidate) => candidate.error <= nearest.error + 10 &&
      Math.abs(candidate.along - nearest.along) > 80).slice(0, 10).map(candidateSummary) }
  const turnOptions = turnCandidates.filter((candidate) => candidate.error <= Math.min(35, nearest.error + 10))
    .sort((a, b) => a.along - b.along)
  const groups = []
  for (const candidate of turnOptions) {
    const group = groups.at(-1)
    if (!group || candidate.along - group.at(-1).along > 80) groups.push([candidate])
    else group.push(candidate)
  }
  report.turnBoundaries = groups.map((group) => {
    const seen = new Set()
    return group.sort((a, b) => a.error - b.error).flatMap((candidate) => {
      const boundary = Math.ceil(candidate.index)
      if (seen.has(boundary) || boundary < 2 || boundary > shape.points.length - 3) return []
      seen.add(boundary)
      return [{ candidate: candidateSummary(candidate), splitIndex: boundary,
        outbound: candidatePaths(ordered.slice(0, turnAt + 1), shape.points, 0, boundary),
        inbound: candidatePaths(ordered.slice(turnAt + 1), shape.points, boundary, shape.points.length - 1) }]
    })
  })
  if (splitIndex < 2 || splitIndex > shape.points.length - 3) return report
  // These two fields intentionally replay the previous nearest-only rule.
  report.legacyOutboundFailure = scan(ordered.slice(0, turnAt + 1), shape.points, 0, splitIndex)
  report.legacyInboundFailure = scan(ordered.slice(turnAt + 1), shape.points, splitIndex, shape.points.length - 1)
  report.outboundCandidatePaths = candidatePaths(ordered.slice(0, turnAt + 1), shape.points, 0, splitIndex)
  report.inboundCandidatePaths = candidatePaths(ordered.slice(turnAt + 1), shape.points, splitIndex, shape.points.length - 1)
  return report
}

function inspect(fixture, sequence) {
  const shape = fixture.shape?.shape ?? fixture.shape
  const stops = fixture.stops?.stops ?? fixture.stops
  const stop = stops.find((item) => item.sequence === sequence)
  if (!stop) throw new Error(`Stop sequence ${sequence} was not found`)
  const turn = stops.find((item) => item.turnYn === true)
  const nearest = project(turn.position, shape.points, 0, shape.points.length - 1)[0]
  const splitIndex = Math.ceil(nearest.index)
  const from = stop.sequence <= turn.sequence ? 0 : splitIndex
  const to = stop.sequence <= turn.sequence ? splitIndex : shape.points.length - 1
  const candidates = project(stop.position, shape.points, from, to)
  return { sequence, stopId: stop.id.value, name: stop.name,
    candidates: candidates.filter((item) => item.error <= STOP_LIMIT).slice(0, 12).map(candidateSummary),
    nearest: candidateSummary(candidates[0]) }
}

if (require.main === module) {
  const file = process.argv[2]
  if (!file) {
    process.stderr.write('Usage: node scripts/diagnose-route-directions.cjs <normalized-fixture.json>\n')
    process.exitCode = 2
  } else {
    try {
      const fixture = JSON.parse(fs.readFileSync(path.resolve(file), 'utf8').replace(/^\uFEFF/, ''))
      const sequences = process.argv.slice(3).map(Number)
      const result = sequences.length ? sequences.map((sequence) => inspect(fixture, sequence)) : analyze(fixture)
      process.stdout.write(`${JSON.stringify(result, null, 2)}\n`)
    } catch (error) {
      process.stderr.write(`Direction diagnosis failed: ${error instanceof Error ? error.message : String(error)}\n`)
      process.exitCode = 1
    }
  }
}

module.exports = { analyze, inspect }
