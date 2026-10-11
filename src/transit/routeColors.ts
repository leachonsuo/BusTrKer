export const ROUTE_COLOR_PRESETS = ['#1769cf', '#21875b', '#e88920', '#8a54c7', '#d13d45', '#e6b31b'] as const

const SECTION_PALETTE = {
  pink: '#ec2183',
  magenta: '#c51cb5',
  blue: '#1769df',
  yellow: '#e3aa00',
  teal: '#008f93',
} as const

const STORAGE_KEY = 'bustracker.route-colors.v1'

export function isHexColor(value: unknown): value is string {
  return typeof value === 'string' && /^#[0-9a-fA-F]{6}$/.test(value)
}

type Lab = { L: number; a: number; b: number; chroma: number; hue: number }

function toOklab(hex: string): Lab {
  const channels = [1, 3, 5].map((offset) => {
    const value = parseInt(hex.slice(offset, offset + 2), 16) / 255
    return value <= 0.04045 ? value / 12.92 : ((value + 0.055) / 1.055) ** 2.4
  })
  const [r, g, b] = channels
  const l = Math.cbrt(0.4122214708 * r + 0.5363325363 * g + 0.0514459929 * b)
  const m = Math.cbrt(0.2119034982 * r + 0.6806995451 * g + 0.1073969566 * b)
  const s = Math.cbrt(0.0883024619 * r + 0.2817188376 * g + 0.6299787005 * b)
  const L = 0.2104542553 * l + 0.793617785 * m - 0.0040720468 * s
  const a = 1.9779984951 * l - 2.428592205 * m + 0.4505937099 * s
  const labB = 0.0259040371 * l + 0.7827717662 * m - 0.808675766 * s
  return { L, a, b: labB, chroma: Math.hypot(a, labB), hue: (Math.atan2(labB, a) * 180 / Math.PI + 360) % 360 }
}

export function oklabDistance(first: string, second: string): number {
  const a = toOklab(first)
  const b = toOklab(second)
  return Math.hypot(a.L - b.L, a.a - b.a, a.b - b.b)
}

/** Choose a vivid map color from a small palette, with a perceptual-distance escape hatch. */
export function sectionColorForRoute(routeColor: string): string {
  if (!isHexColor(routeColor)) return SECTION_PALETTE.pink
  const base = toOklab(routeColor)
  let preferred: string
  if (base.chroma < 0.045) preferred = base.L < 0.43 ? SECTION_PALETTE.yellow : base.L > 0.8 ? SECTION_PALETTE.blue : SECTION_PALETTE.pink
  else if (base.hue < 35 || base.hue >= 345) preferred = SECTION_PALETTE.teal
  else if (base.hue < 135) preferred = SECTION_PALETTE.blue
  else if (base.hue < 205) preferred = SECTION_PALETTE.magenta
  else if (base.hue < 285) preferred = SECTION_PALETTE.pink
  else preferred = SECTION_PALETTE.yellow

  if (oklabDistance(routeColor, preferred) >= 0.19) return preferred
  return Object.values(SECTION_PALETTE).reduce((best, candidate) =>
    oklabDistance(routeColor, candidate) > oklabDistance(routeColor, best) ? candidate : best)
}

export function sectionHaloColor(sectionColor: string): string {
  return toOklab(sectionColor).L > 0.72 ? '#19323b' : '#ffffff'
}

export function loadRouteColors(): Map<string, string> {
  try {
    const stored = JSON.parse(window.localStorage.getItem(STORAGE_KEY) ?? '{}') as unknown
    if (!stored || typeof stored !== 'object' || Array.isArray(stored)) return new Map()
    return new Map(Object.entries(stored).filter((entry): entry is [string, string] => isHexColor(entry[1])))
  } catch { return new Map() }
}

export function persistRouteColors(colors: Map<string, string>): void {
  try { window.localStorage.setItem(STORAGE_KEY, JSON.stringify(Object.fromEntries(colors))) }
  catch { /* Storage may be disabled; the current session still keeps the colors. */ }
}
