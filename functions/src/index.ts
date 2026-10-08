import { onRequest } from 'firebase-functions/v2/https'
import { gbisStopProvider, TransitApiError } from './transit/gbis'
import { publicDataServiceKey } from './transit/secrets'

export const api = onRequest(
  { region: 'asia-northeast3', cors: false, secrets: [publicDataServiceKey] },
  async (request, response) => {
    response.set('Cache-Control', 'no-store')
    if (request.method === 'GET' && request.path === '/api/health') {
      response.status(200).json({ status: 'ok', transitData: 'not-connected' })
      return
    }

    if (request.method !== 'GET') {
      response.status(405).json({ error: 'METHOD_NOT_ALLOWED', message: 'GET 요청만 지원합니다.' })
      return
    }

    const isNearby = request.path === '/api/stops/nearby'
    const arrivalMatch = /^\/api\/stops\/(\d{1,20})\/arrivals$/.exec(request.path)
    if (!isNearby && !arrivalMatch) {
      response.status(404).json({ error: 'NOT_FOUND', message: 'API 경로를 찾을 수 없습니다.' })
      return
    }

    try {
      let latitude = 0
      let longitude = 0
      if (isNearby) {
        latitude = Number(request.query.lat)
        longitude = Number(request.query.lng)
        if (typeof request.query.lat !== 'string' || typeof request.query.lng !== 'string' || !request.query.lat.trim() || !request.query.lng.trim() || !Number.isFinite(latitude) || !Number.isFinite(longitude) || Math.abs(latitude) > 90 || Math.abs(longitude) > 180) {
          response.status(400).json({ error: 'INVALID_COORDINATES', message: '유효한 위도와 경도가 필요합니다.' })
          return
        }
      }
      const serviceKey = publicDataServiceKey.value()?.trim()
      if (!serviceKey) {
        response.status(503).json({ error: 'API_KEY_NOT_CONFIGURED', message: '공공데이터 서비스키가 서버에 설정되지 않았습니다.' })
        return
      }
      const provider = gbisStopProvider(serviceKey)
      if (isNearby) {
        response.status(200).json(await provider.nearbyStops!({ latitude, longitude }, 'gyeonggi'))
        return
      }
      response.status(200).json(await provider.arrivals!({ provider: 'gbis', regionCode: 'gyeonggi', value: arrivalMatch![1] }))
    } catch (error) {
      if (error instanceof TransitApiError) {
        response.status(error.status).json({ error: error.code, message: error.message })
        return
      }
      // Do not log upstream URL, raw body, or secret-bearing error objects.
      response.status(500).json({ error: 'SERVER_ERROR', message: '서버에서 요청을 처리하지 못했습니다.' })
    }
  },
)
