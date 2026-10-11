const test = require('node:test')
const assert = require('node:assert/strict')
const fs = require('node:fs')
const path = require('node:path')
const ts = require('typescript')

const source = fs.readFileSync(path.join(__dirname, '..', 'src/transit/routeColors.ts'), 'utf8')
const code = ts.transpileModule(source, { compilerOptions: { module: ts.ModuleKind.CommonJS,
  target: ts.ScriptTarget.ES2022 } }).outputText
const mod = { exports: {} }
new Function('module', 'exports', code)(mod, mod.exports)
const { sectionColorForRoute, sectionHaloColor, oklabDistance, isHexColor, loadRouteColors, persistRouteColors } = mod.exports

test('contrasting palette follows the requested distinct color families', () => {
  for (const [base, section] of [
    ['#1769cf', '#ec2183'], ['#21875b', '#c51cb5'], ['#e88920', '#1769df'],
    ['#e6b31b', '#1769df'], ['#8a54c7', '#e3aa00'], ['#d13d45', '#008f93'],
  ]) {
    assert.equal(sectionColorForRoute(base), section)
    assert.ok(oklabDistance(base, section) > 0.25)
  }
})

test('neutral and arbitrary custom colors retain perceptual separation and visible section colors', () => {
  for (const base of ['#ffffff', '#000000', '#808080', '#eeeeee', '#343434', '#123456', '#a3c176', '#ff00ff']) {
    const section = sectionColorForRoute(base)
    assert.ok(isHexColor(section))
    assert.notEqual(section.toLowerCase(), base)
    assert.ok(oklabDistance(base, section) >= 0.19, `${base} and ${section} need perceptual distance`)
    assert.ok(isHexColor(sectionHaloColor(section)))
  }
  assert.equal(sectionColorForRoute('invalid'), '#ec2183')
})

test('route colors persist by route identity and ignore malformed stored colors', () => {
  const previous = global.window
  let value = null
  global.window = { localStorage: { getItem: () => value, setItem: (_, next) => { value = next } } }
  try {
    const colors = new Map([['gbis:gyeonggi:219000001', '#123456']])
    persistRouteColors(colors)
    assert.equal(loadRouteColors().get('gbis:gyeonggi:219000001'), '#123456')
    value = '{"valid":"#abcdef","bad":"javascript:alert(1)"}'
    assert.deepEqual([...loadRouteColors()], [['valid', '#abcdef']])
  } finally { global.window = previous }
})
