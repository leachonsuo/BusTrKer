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
  startName: string | null
  endName: string | null
  typeName: string | null
  regionName: string | null
  startStopId: TransitId | null
  endStopId: TransitId | null
}

export interface RouteStop extends Stop {
  sequence: number
  turnYn: boolean | null
  turnSequence: number | null
}

export interface RouteStopsResult { routeId: TransitId; stops: RouteStop[]; queriedAt: string; source: ProviderId }

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

// The GBIS location feed reports stop progression, not a GPS coordinate or measurement time.
export interface VehiclePosition {
  kind: 'stop-progress'
  routeId: TransitId
  vehicleId: string
  stationSequence: number
  stateCode: 0 | 1 | 2
  currentStopId: TransitId
  nextStopId: TransitId | null
  sectionVerified: boolean
  observedAt: null
}

export interface VehiclePositionsResult {
  routeId: TransitId
  vehicles: VehiclePosition[]
  queriedAt: string
  source: ProviderId
}

export interface RouteShape {
  routeId: TransitId
  points: Coordinates[]
}

export interface RouteShapeResult { shape: RouteShape | null; queriedAt: string; source: ProviderId }
export interface RouteSearchResult { routes: Route[]; queriedAt: string; source: ProviderId }
export interface RouteDetailResult { route: Route | null; queriedAt: string; source: ProviderId }

export interface TransitProvider {
  readonly id: ProviderId
  readonly supportedRegions: readonly string[]
  searchRoutes?(query: string, regionCode: string): Promise<RouteSearchResult>
  routeDetail?(routeId: TransitId): Promise<RouteDetailResult>
  routeStops?(routeId: TransitId): Promise<RouteStopsResult>
  nearbyStops?(position: Coordinates, regionCode: string): Promise<NearbyStopsResult>
  arrivals?(stopId: TransitId): Promise<StopArrivalsResult>
  routeShape?(routeId: TransitId): Promise<RouteShapeResult>
  vehiclePositions?(routeId: TransitId): Promise<VehiclePositionsResult>
}
