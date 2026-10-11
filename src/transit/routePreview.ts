import type { RouteShape } from './api'
import type { DirectionSplit } from './routeDirections'

export interface RoutePreview {
  shape: RouteShape
  source: 'first-direction' | 'fallback-full-route'
  directionLabel: string | null
}

/** The first visit-ordered direction is a stable preview for every supported route. */
export function routePreview(shape: RouteShape | null, split: DirectionSplit | undefined,
  stopsFailed = false): RoutePreview | null {
  if (!shape) return null
  if (split?.directions) return { shape: split.directions[0].shape,
    source: 'first-direction', directionLabel: split.directions[0].label }
  if (split?.directions === null || stopsFailed) return { shape, source: 'fallback-full-route', directionLabel: null }
  return null
}
