import type { LatLng } from './kakao'

export interface DirectionArrow { position: LatLng; angle: number }

// Spacing is measured in viewport pixels. Interpolation remains on verified shape segments.
export function routeArrows(
  points: LatLng[], project: (point: LatLng) => { x: number; y: number },
  width: number, height: number, spacing: number, limit: number,
): DirectionArrow[] {
  const arrows: DirectionArrow[] = []
  let walked = 0
  let next = spacing / 2
  for (let index = 1; index < points.length && arrows.length < limit; index++) {
    const from = points[index - 1]
    const to = points[index]
    const a = project(from)
    const b = project(to)
    const dx = b.x - a.x
    const dy = b.y - a.y
    const length = Math.hypot(dx, dy)
    if (!Number.isFinite(length) || length < 1) continue
    if ((a.x < -12 && b.x < -12) || (a.x > width + 12 && b.x > width + 12) ||
        (a.y < -12 && b.y < -12) || (a.y > height + 12 && b.y > height + 12)) {
      if (next <= walked + length) next += (Math.floor((walked + length - next) / spacing) + 1) * spacing
      walked += length
      continue
    }
    while (next <= walked + length && arrows.length < limit) {
      const fraction = (next - walked) / length
      const x = a.x + dx * fraction
      const y = a.y + dy * fraction
      if (x >= -12 && x <= width + 12 && y >= -12 && y <= height + 12) {
        arrows.push({ position: {
          latitude: from.latitude + (to.latitude - from.latitude) * fraction,
          longitude: from.longitude + (to.longitude - from.longitude) * fraction,
        }, angle: Math.atan2(dy, dx) * 180 / Math.PI })
      }
      next += spacing
    }
    walked += length
  }
  if (arrows.length === 0 && limit > 0) {
    let longest = 0
    let fallback: DirectionArrow | null = null
    for (let index = 1; index < points.length; index++) {
      const from = points[index - 1]
      const to = points[index]
      const a = project(from)
      const b = project(to)
      const length = Math.hypot(b.x - a.x, b.y - a.y)
      const x = (a.x + b.x) / 2
      const y = (a.y + b.y) / 2
      if (length > longest && x >= 0 && x <= width && y >= 0 && y <= height) {
        longest = length
        fallback = { position: { latitude: (from.latitude + to.latitude) / 2, longitude: (from.longitude + to.longitude) / 2 },
          angle: Math.atan2(b.y - a.y, b.x - a.x) * 180 / Math.PI }
      }
    }
    if (fallback) arrows.push(fallback)
  }
  return arrows
}
