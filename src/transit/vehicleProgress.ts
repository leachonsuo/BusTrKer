import type { VehiclePosition } from './api'

export interface VehicleTransition {
  fromSequence: number
  toSequence: number
  fromState: 0 | 1 | 2
  toState: 0 | 1 | 2
}

/** Connects successive observations by provider vehicle ID, never by array position. */
export function vehicleTransitions(before: VehiclePosition[], after: VehiclePosition[]): Record<string, VehicleTransition> {
  const previous = new Map(before.map((vehicle) => [vehicle.vehicleId, vehicle]))
  const changes: Record<string, VehicleTransition> = {}
  for (const current of after) {
    const old = previous.get(current.vehicleId)
    if (!old || old.routeId.provider !== current.routeId.provider || old.routeId.regionCode !== current.routeId.regionCode ||
        old.routeId.value !== current.routeId.value ||
        (old.stationSequence === current.stationSequence && old.stateCode === current.stateCode)) continue
    changes[current.vehicleId] = {
      fromSequence: old.stationSequence, toSequence: current.stationSequence,
      fromState: old.stateCode, toState: current.stateCode,
    }
  }
  return changes
}
