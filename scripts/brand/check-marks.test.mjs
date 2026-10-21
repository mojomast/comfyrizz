import test from 'node:test'
import assert from 'node:assert/strict'
import { existsSync, readFileSync } from 'node:fs'
import { join } from 'node:path'
import {
  BRAND_DIR,
  analyseSvg,
  centringInfo,
  checkBrand,
  formatReport,
  parsePathData,
  parseXml,
  wordmarkInfo,
} from './check-marks.mjs'

const report = checkBrand()
const reportText = formatReport(report)

test('every brand SVG master passes all structural checks', () => {
  assert.deepEqual(report.errors, [], reportText)
  assert.ok(report.files.length >= 7, 'expected the full brand SVG set')
  for (const file of report.files) {
    assert.equal(file.errors.length, 0, `${file.file}:\n${file.errors.join('\n')}`)
    assert.ok(file.viewBox, `${file.file} must declare a viewBox`)
  }
})

test('wordmarks spell comfyrizz with exactly two final z letters', () => {
  const wordmarks = report.files.filter(file => file.wordmark)
  assert.ok(wordmarks.length >= 4, 'expected wordmark paths in the standalone mark, lockups and social card')
  for (const file of wordmarks) {
    assert.equal(file.wordmark.word, 'comfyrizz', file.file)
    assert.equal(file.wordmark.zCount, 2, `${file.file} must contain exactly two z paths`)
    assert.ok(file.wordmark.word.endsWith('zz'), `${file.file} must end in zz`)
    assert.deepEqual(
      file.wordmark.letters,
      ['c', 'o', 'm', 'f', 'y', 'r', 'i', 'z', 'z'],
      `${file.file} must order the ids c,o,m,f,y,r,i,z,z`,
    )
  }
})

test('symbol path data is identical across every lockup and the standalone symbol', () => {
  const expected = [
    'M 20 57 L 95 24 L 59 84 L 92 81 L 17 114 L 53 54 Z',
    'M 68 78 L 143 45 L 107 105 L 140 102 L 65 135 L 101 75 Z',
  ]
  assert.ok(report.symbolMasters.length >= 5, reportText)
  for (const file of report.files.filter(entry => entry.symbol)) {
    assert.deepEqual(file.symbol.data, expected, `${file.file} does not use the shared symbol geometry`)
  }
})

test('symbol and favicon are centred in their square viewBoxes within 2 percent', () => {
  const symbol = report.files.find(file => file.file === 'comfyrizz-symbol.svg')
  const favicon = report.files.find(file => file.file === 'favicon.svg')
  for (const file of [symbol, favicon]) {
    assert.ok(file, `missing proof file ${file?.file ?? ''}`)
    assert.ok(file.centring, `${file.file} has no square symbol bounds`)
    assert.ok(
      file.centring.withinTolerance,
      `${file.file} bbox centre (${file.centring.centerX}, ${file.centring.centerY}) is outside the 2% tolerance`,
    )
  }
  assert.ok(favicon.centring.limitX > 0, 'favicon centring check must use a real 2% tolerance')
})

test('centring tolerance rejects a 3 percent shift', () => {
  const centred = centringInfo([[10, 10], [90, 90]], [0, 0, 100, 100])
  const shifted = centringInfo([[13, 13], [93, 93]], [0, 0, 100, 100])
  assert.equal(centred.withinTolerance, true)
  assert.equal(shifted.withinTolerance, false)
  assert.ok(Math.abs(shifted.offsetX) > shifted.limitX)
})

test('detects a third z in the wordmark ids', () => {
  const parsed = parseXml(`
    <svg xmlns="http://www.w3.org/2000/svg">
      <path id="letter-z-1" d="M0 0H1V1Z"/>
      <path id="letter-z-2" d="M1 0H2V1Z"/>
      <path id="letter-z-3" d="M2 0H3V1Z"/>
    </svg>`)
  const info = wordmarkInfo(parsed.elements)
  assert.ok(info.errors.some(error => /exactly 2/.test(error)), info.errors.join('\n'))
  assert.ok(info.errors.some(error => /spell/.test(error)), info.errors.join('\n'))
})

test('detects an off-centre symbol bounding box', () => {
  const svg = `<svg xmlns="http://www.w3.org/2000/svg" viewBox="0 0 100 100">
    <path id="symbol-z-violet" d="M 10 10 L 40 10 L 40 40 L 10 40 Z"/>
    <path id="symbol-z-mint" d="M 11 11 L 41 11 L 41 41 L 11 41 Z"/>
  </svg>`
  const result = analyseSvg('off-centre.svg', svg)
  assert.ok(result.centring)
  assert.equal(result.centring.withinTolerance, false)
  assert.ok(result.errors.some(error => /bbox centre/.test(error)), result.errors.join('\n'))
})

test('detects coordinates outside the viewBox', () => {
  const svg = `<svg xmlns="http://www.w3.org/2000/svg" viewBox="0 0 10 10">
    <path id="symbol-z-violet" d="M -1 0 L 5 0 L 5 5 Z"/>
    <path id="symbol-z-mint" d="M 0 0 L 6 6 L 0 6 Z"/>
  </svg>`
  const result = analyseSvg('clipped.svg', svg)
  assert.ok(result.errors.some(error => /outside viewBox/.test(error)), result.errors.join('\n'))
})

test('detects bitmaps, text, gradients, filters, fonts and network references', () => {
  const svg = `<svg xmlns="http://www.w3.org/2000/svg" viewBox="0 0 10 10" font-family="Arial">
    <defs>
      <linearGradient id="g"><stop offset="0"/></linearGradient>
      <filter id="f"/>
    </defs>
    <image href="https://example.com/mark.png" width="10" height="10"/>
    <text x="1" y="1">comfyrizz</text>
    <path d="M 0 0 H 10 V 10 Z" fill="url(#g)"/>
  </svg>`
  const result = analyseSvg('forbidden.svg', svg)
  const errors = result.errors.join('\n')
  assert.match(errors, /<image>/)
  assert.match(errors, /text elements/)
  assert.match(errors, /gradient/)
  assert.match(errors, /filter/)
  assert.match(errors, /font/)
  assert.match(errors, /http/i)
  assert.match(errors, /url\(\)/)
})

test('detects embedded data and malformed XML', () => {
  const embedded = analyseSvg('embedded.svg', `<svg xmlns="http://www.w3.org/2000/svg" viewBox="0 0 10 10">
    <image href="data:image/png;base64,AAAA" width="1" height="1"/>
  </svg>`)
  assert.ok(embedded.errors.some(error => /data:/.test(error)))

  const malformed = parseXml('<svg><g></svg>')
  assert.ok(malformed.errors.some(error => /mismatched closing tag/.test(error)), malformed.errors.join('\n'))
})

test('path parser handles relative commands and transforms', () => {
  const points = parsePathData('m 10 10 h 5 v 5 z')
  assert.deepEqual(points, [[10, 10], [15, 10], [15, 15], [10, 10]])
})

test('proof sheet is offline and references only local brand SVGs', () => {
  const html = readFileSync(join(BRAND_DIR, 'proof-sheet.html'), 'utf8')
  const refs = [...html.matchAll(/(?:src|href)="([^"]+)"/g)].map(match => match[1])
  assert.ok(refs.length > 0, 'proof sheet should reference the SVG masters')
  assert.doesNotMatch(html, /https?:\/\//i, 'proof sheet must not contain network references')
  for (const ref of refs) {
    assert.doesNotMatch(ref, /^(?:[a-z][a-z0-9+.-]*:|\/\/)/i, `non-local reference ${ref}`)
    assert.ok(existsSync(join(BRAND_DIR, ref)), `missing proof sheet asset ${ref}`)
  }
  assert.match(html, /prefers-reduced-motion/, 'proof sheet must document reduced motion')
  assert.match(html, /comfyrizz-logo-light\.svg/)
  assert.match(html, /comfyrizz-logo-dark\.svg/)
  assert.match(html, /comfyrizz-logo-mono\.svg/)
  assert.match(html, /comfyrizz-symbol\.svg/)
  assert.match(html, /favicon\.svg/)
})
