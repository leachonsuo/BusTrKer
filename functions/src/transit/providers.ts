import type { ProviderId } from './domain'

// Capability catalog; only GBIS is wired. Precision/TAGO entries describe documented, inactive capabilities.
export const providerCatalog: Record<ProviderId, { documentation: string; capabilities: readonly string[] }> = {
  gbis: {
    documentation: 'https://www.gbis.go.kr/gbis2014/publicService.action?cmd=openApiInfo',
    capabilities: ['routes', 'route-shape', 'stops', 'nearby-stops', 'arrivals', 'stop-based-vehicle-position'],
  },
  precision: {
    documentation: 'https://www.data.go.kr/data/15157601/openapi.do',
    capabilities: ['route-basics', 'route-stops', 'gps-vehicle-position'],
  },
  tago: {
    documentation: 'https://www.data.go.kr/data/15098533/openapi.do',
    capabilities: ['gps-vehicle-position'],
  },
}
