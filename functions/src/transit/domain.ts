export type ProviderId = 'gbis' | 'precision' | 'tago'

export interface Coordinates {
  latitude: number
  longitude: number
}

export interface TransitId {
  provider: ProviderId
  regionCode: string
  value: string
}

export interface Route {
  id: TransitId
  name: string
}

export interface Stop {
  id: TransitId
  name: string
  position: Coordinates
  mobileNo: string | null
  distanceMeters: number | null
}

export interface ArrivalVisit {
  minutesUntilArrival: number | null
  stopsAway: number | null
}

export interface StopArrival {
  routeId: TransitId
  stopId: TransitId
  routeName: string
  destination: string | null
  operationStatus: 'running' | 'ended' | 'waiting' | 'unknown'
  visits: ArrivalVisit[]
}

export interface NearbyStopsResult { stops: Stop[]; queriedAt: string; source: ProviderId }
export interface StopArrivalsResult { arrivals: StopArrival[]; queriedAt: string; source: ProviderId }

// A stop-based position is deliberately distinct from a GPS coordinate.
export type VehiclePosition =
  | { kind: 'gps'; routeId: TransitId; vehicleId: string; position: Coordinates; observedAt: string | null }
  | { kind: 'between-stops'; routeId: TransitId; vehicleId: string; currentStopId: TransitId; nextStopId: TransitId | null; observedAt: string | null }

export interface RouteShape {
  routeId: TransitId
  points: Coordinates[]
}

export interface TransitProvider {
  readonly id: ProviderId
  readonly supportedRegions: readonly string[]
  searchRoutes?(query: string, regionCode: string): Promise<Route[]>
  nearbyStops?(position: Coordinates, regionCode: string): Promise<NearbyStopsResult>
  arrivals?(stopId: TransitId): Promise<StopArrivalsResult>
  routeShape?(routeId: TransitId): Promise<RouteShape | null>
  vehiclePositions?(routeId: TransitId): Promise<VehiclePosition[]>
}
