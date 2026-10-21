#!/usr/bin/env node
import { readFileSync, readdirSync } from 'node:fs'
import { dirname, join, resolve } from 'node:path'
import { fileURLToPath, pathToFileURL } from 'node:url'

const HERE = dirname(fileURLToPath(import.meta.url))
export const REPO_ROOT = resolve(HERE, '../..')
export const BRAND_DIR = join(REPO_ROOT, 'brand')

const LETTER_ORDER = ['c', 'o', 'm', 'f', 'y', 'r', 'i', 'z', 'z']
const SYMBOL_IDS = ['symbol-z-violet', 'symbol-z-mint']
const FAVICON_IDS = ['favicon-z-violet', 'favicon-z-mint']

const COMMAND_ARITY = { M: 2, L: 2, H: 1, V: 1, C: 6, S: 4, Q: 4, T: 2, A: 7, Z: 0 }

function decodeXml(value) {
  return value.replace(/&(amp|lt|gt|quot|apos|#\d+|#x[0-9a-fA-F]+);/g, (match, name) => {
    if (name === 'amp') return '&'
    if (name === 'lt') return '<'
    if (name === 'gt') return '>'
    if (name === 'quot') return '"'
    if (name === 'apos') return "'"
    const code = name[1].toLowerCase() === 'x' ? Number.parseInt(name.slice(2), 16) : Number.parseInt(name.slice(1), 10)
    return Number.isFinite(code) ? String.fromCodePoint(code) : match
  })
}

function findTagEnd(source, start) {
  let quote = null
  for (let index = start + 1; index < source.length; index += 1) {
    const char = source[index]
    if (quote) {
      if (char === quote) quote = null
      else if (char === '<') return { error: 'raw "<" inside an attribute value' }
    } else if (char === '"' || char === "'") {
      quote = char
    } else if (char === '>') {
      return { end: index }
    }
  }
  return { error: 'unterminated start tag' }
}

function parseAttributes(text, errors, tagName) {
  const attrs = {}
  let rest = text
  while (rest.trim().length > 0) {
    const match = rest.match(/^\s*([A-Za-z_:][A-Za-z0-9_:.-]*)\s*=\s*(?:"([^"]*)"|'([^']*)')/)
    if (!match) {
      errors.push(`malformed attribute in <${tagName}>: ${rest.trim().slice(0, 60)}`)
      break
    }
    const name = match[1]
    const value = match[2] ?? match[3] ?? ''
    if (Object.hasOwn(attrs, name)) errors.push(`duplicate attribute "${name}" on <${tagName}>`)
    attrs[name] = decodeXml(value)
    rest = rest.slice(match[0].length)
  }
  return attrs
}

/**
 * Small, dependency-free XML tree builder. It enforces one root, balanced tags,
 * quoted attributes and legal entities, which is enough for these hand-authored SVGs.
 */
export function parseXml(source) {
  const errors = []
  const elements = []
  const ids = new Map()
  const stack = []
  let rootIndex = null
  let index = 0

  if (/^<\?xml[^>]*\?>\s*$/.test(source)) errors.push('document has no root element')
  if (/&(?!(?:amp|lt|gt|quot|apos|#\d+|#x[0-9a-fA-F]+);)/.test(source)) {
    errors.push('unescaped "&" entity in document')
  }

  while (index < source.length) {
    const lt = source.indexOf('<', index)
    if (lt === -1) break
    index = lt

    if (source.startsWith('<!--', index)) {
      const end = source.indexOf('-->', index + 4)
      if (end === -1) { errors.push('unterminated comment'); break }
      index = end + 3
      continue
    }
    if (source.startsWith('<![CDATA[', index)) {
      const end = source.indexOf(']]>', index + 9)
      if (end === -1) { errors.push('unterminated CDATA section'); break }
      index = end + 3
      continue
    }
    if (source.startsWith('<?', index)) {
      const end = source.indexOf('?>', index + 2)
      if (end === -1) { errors.push('unterminated processing instruction'); break }
      index = end + 2
      continue
    }
    if (source.startsWith('<!', index)) {
      errors.push('DOCTYPE/declaration is not allowed in a brand master')
      const end = source.indexOf('>', index + 2)
      if (end === -1) break
      index = end + 1
      continue
    }

    if (source.startsWith('</', index)) {
      const end = source.indexOf('>', index + 2)
      if (end === -1) { errors.push('unterminated closing tag'); break }
      const body = source.slice(index + 2, end).trim()
      if (!/^[A-Za-z_][A-Za-z0-9_:.-]*$/.test(body)) errors.push(`malformed closing tag </${body}>`)
      const expected = stack.pop()
      if (expected === undefined) errors.push(`unexpected closing tag </${body}>`)
      else if (elements[expected].name !== body) {
        errors.push(`mismatched closing tag </${body}>; expected </${elements[expected].name}>`)
      }
      index = end + 1
      continue
    }

    const tagEnd = findTagEnd(source, index)
    if (tagEnd.error) { errors.push(tagEnd.error); break }
    const end = tagEnd.end
    let body = source.slice(index + 1, end).trim()
    const selfClosing = body.endsWith('/')
    if (selfClosing) body = body.slice(0, -1).trim()
    const nameMatch = body.match(/^([A-Za-z_][A-Za-z0-9_:.-]*)/)
    if (!nameMatch) { errors.push('start tag has no element name'); index = end + 1; continue }
    const name = nameMatch[1]
    const attrs = parseAttributes(body.slice(name.length), errors, name)
    const parent = stack.length ? stack[stack.length - 1] : null
    const elementIndex = elements.length

    if (parent === null) {
      if (rootIndex !== null) errors.push('document has more than one root element')
      else rootIndex = elementIndex
    } else {
      elements[parent].children.push(elementIndex)
    }
    if (attrs.id !== undefined) {
      if (ids.has(attrs.id)) errors.push(`duplicate id "${attrs.id}"`)
      else ids.set(attrs.id, elementIndex)
    }
    elements.push({ name, attrs, children: [], parent, index: elementIndex })
    if (!selfClosing) stack.push(elementIndex)
    index = end + 1
  }

  if (stack.length > 0) errors.push(`unclosed element <${elements[stack[stack.length - 1]].name}>`)
  if (rootIndex === null) errors.push('document has no root element')
  return { errors, elements, ids, rootIndex }
}

function numbers(text, context) {
  if (text === undefined) throw new Error(`${context}: missing number list`)
  const values = text.trim().split(/[\s,]+/).filter(Boolean).map(Number)
  if (values.length === 0 || values.some(value => !Number.isFinite(value))) {
    throw new Error(`${context}: invalid number list "${text}"`)
  }
  return values
}

function multiply(m1, m2) {
  return [
    m1[0] * m2[0] + m1[2] * m2[1],
    m1[1] * m2[0] + m1[3] * m2[1],
    m1[0] * m2[2] + m1[2] * m2[3],
    m1[1] * m2[2] + m1[3] * m2[3],
    m1[0] * m2[4] + m1[2] * m2[5] + m1[4],
    m1[1] * m2[4] + m1[3] * m2[5] + m1[5],
  ]
}

function applyMatrix(matrix, [x, y]) {
  return [matrix[0] * x + matrix[2] * y + matrix[4], matrix[1] * x + matrix[3] * y + matrix[5]]
}

export function parseTransform(text) {
  let matrix = [1, 0, 0, 1, 0, 0]
  if (!text || !text.trim()) return matrix
  let consumed = 0
  const re = /([A-Za-z]+)\s*\(([^)]*)\)/g
  let match
  while ((match = re.exec(text))) {
    if (!/^[\s,]*$/.test(text.slice(consumed, match.index))) {
      throw new Error(`invalid transform list near "${text.slice(consumed, match.index)}"`)
    }
    consumed = re.lastIndex
    const name = match[1]
    const values = numbers(match[2], `transform ${name}()`)
    let op
    if (name === 'translate') {
      const [tx, ty = 0] = values
      if (values.length > 2) throw new Error('translate() takes one or two numbers')
      op = [1, 0, 0, 1, tx, ty]
    } else if (name === 'scale') {
      const [sx, sy = sx] = values
      if (values.length > 2) throw new Error('scale() takes one or two numbers')
      op = [sx, 0, 0, sy, 0, 0]
    } else if (name === 'matrix') {
      if (values.length !== 6) throw new Error('matrix() takes six numbers')
      op = values
    } else if (name === 'rotate') {
      const [angle, cx = 0, cy = 0] = values
      if (values.length !== 1 && values.length !== 3) throw new Error('rotate() takes one or three numbers')
      const radians = angle * Math.PI / 180
      const cos = Math.cos(radians)
      const sin = Math.sin(radians)
      op = multiply(multiply([1, 0, 0, 1, cx, cy], [cos, sin, -sin, cos, 0, 0]), [1, 0, 0, 1, -cx, -cy])
    } else if (name === 'skewX' || name === 'skewY') {
      if (values.length !== 1) throw new Error(`${name}() takes one number`)
      const tangent = Math.tan(values[0] * Math.PI / 180)
      op = name === 'skewX' ? [1, 0, tangent, 1, 0, 0] : [1, tangent, 0, 1, 0, 0]
    } else {
      throw new Error(`unsupported transform ${name}()`)
    }
    matrix = multiply(matrix, op)
  }
  if (!/^[\s,]*$/.test(text.slice(consumed))) throw new Error(`invalid trailing transform text "${text.slice(consumed)}"`)
  return matrix
}

/**
 * Parses path data and returns both endpoints and Bezier/arc control points.
 * Control points are included in bounds checks so an off-canvas curve cannot hide
 * behind an on-canvas endpoint.
 */
export function parsePathData(d) {
  if (typeof d !== 'string' || !d.trim()) throw new Error('path has no d attribute')
  const tokens = []
  const re = /([MmLlHhVvCcSsQqTtAaZz])|([-+]?(?:(?:\d+\.\d*)|(?:\.\d+)|(?:\d+))(?:[eE][-+]?\d+)?)/g
  let consumed = 0
  let match
  while ((match = re.exec(d))) {
    if (!/^[\s,]*$/.test(d.slice(consumed, match.index))) {
      throw new Error(`invalid path data near "${d.slice(consumed, match.index)}"`)
    }
    consumed = re.lastIndex
    tokens.push(match[1] ? { type: 'command', value: match[1] } : { type: 'number', value: Number(match[2]) })
  }
  if (!/^[\s,]*$/.test(d.slice(consumed))) throw new Error(`invalid trailing path data "${d.slice(consumed)}"`)

  const points = []
  let index = 0
  let command = null
  let x = 0
  let y = 0
  let startX = 0
  let startY = 0
  let cubicControl = null
  let quadControl = null

  const take = count => {
    const out = []
    for (let i = 0; i < count; i += 1) {
      const token = tokens[index]
      if (!token || token.type !== 'number') throw new Error(`path command ${command} expects ${count} numbers`)
      out.push(token.value)
      index += 1
    }
    return out
  }

  while (index < tokens.length) {
    const token = tokens[index]
    if (token.type === 'command') {
      command = token.value
      index += 1
      if (command.toUpperCase() === 'Z') {
        x = startX
        y = startY
        cubicControl = null
        quadControl = null
        points.push([x, y])
        command = null
        continue
      }
    } else if (!command) {
      throw new Error('path data starts with a number, not a command')
    }

    const upper = command.toUpperCase()
    const relative = command !== upper
    const arity = COMMAND_ARITY[upper]
    if (arity === undefined) throw new Error(`unsupported path command ${command}`)
    const values = take(arity)

    if (upper === 'M' || upper === 'L') {
      x = relative ? x + values[0] : values[0]
      y = relative ? y + values[1] : values[1]
      points.push([x, y])
      if (upper === 'M') {
        startX = x
        startY = y
        command = relative ? 'l' : 'L'
      }
      cubicControl = null
      quadControl = null
    } else if (upper === 'H') {
      x = relative ? x + values[0] : values[0]
      points.push([x, y])
      cubicControl = null
      quadControl = null
    } else if (upper === 'V') {
      y = relative ? y + values[0] : values[0]
      points.push([x, y])
      cubicControl = null
      quadControl = null
    } else if (upper === 'C') {
      const c1 = relative ? [x + values[0], y + values[1]] : [values[0], values[1]]
      const c2 = relative ? [x + values[2], y + values[3]] : [values[2], values[3]]
      const end = relative ? [x + values[4], y + values[5]] : [values[4], values[5]]
      points.push(c1, c2, end)
      x = end[0]
      y = end[1]
      cubicControl = c2
      quadControl = null
    } else if (upper === 'S') {
      const c1 = cubicControl ? [2 * x - cubicControl[0], 2 * y - cubicControl[1]] : [x, y]
      const c2 = relative ? [x + values[0], y + values[1]] : [values[0], values[1]]
      const end = relative ? [x + values[2], y + values[3]] : [values[2], values[3]]
      points.push(c1, c2, end)
      x = end[0]
      y = end[1]
      cubicControl = c2
      quadControl = null
    } else if (upper === 'Q') {
      const c1 = relative ? [x + values[0], y + values[1]] : [values[0], values[1]]
      const end = relative ? [x + values[2], y + values[3]] : [values[2], values[3]]
      points.push(c1, end)
      x = end[0]
      y = end[1]
      quadControl = c1
      cubicControl = null
    } else if (upper === 'T') {
      const c1 = quadControl ? [2 * x - quadControl[0], 2 * y - quadControl[1]] : [x, y]
      const end = relative ? [x + values[0], y + values[1]] : [values[0], values[1]]
      points.push(c1, end)
      x = end[0]
      y = end[1]
      quadControl = c1
      cubicControl = null
    } else if (upper === 'A') {
      const end = relative ? [x + values[5], y + values[6]] : [values[5], values[6]]
      points.push([x, y], end)
      x = end[0]
      y = end[1]
      cubicControl = null
      quadControl = null
    }
  }
  return points
}

function matrixFor(elements, index, memo = new Map()) {
  if (memo.has(index)) return memo.get(index)
  const element = elements[index]
  const parentMatrix = element.parent === null ? [1, 0, 0, 1, 0, 0] : matrixFor(elements, element.parent, memo)
  const local = parseTransform(element.attrs.transform)
  const matrix = multiply(parentMatrix, local)
  memo.set(index, matrix)
  return matrix
}

function idElement(elements, id) {
  return elements.find(element => element.attrs.id === id)
}

function pathPoints(element, matrix) {
  return parsePathData(element.attrs.d).map(point => applyMatrix(matrix, point))
}

function bbox(points) {
  const xs = points.map(point => point[0])
  const ys = points.map(point => point[1])
  return { minX: Math.min(...xs), minY: Math.min(...ys), maxX: Math.max(...xs), maxY: Math.max(...ys) }
}

function shapePoints(element, matrix) {
  const attrs = element.attrs
  const shape = element.name.toLowerCase()
  if (shape === 'rect') {
    const x = attrs.x === undefined ? 0 : Number(attrs.x)
    const y = attrs.y === undefined ? 0 : Number(attrs.y)
    const width = Number(attrs.width)
    const height = Number(attrs.height)
    if (![x, y, width, height].every(Number.isFinite)) throw new Error('rect has invalid x/y/width/height')
    return [[x, y], [x + width, y], [x + width, y + height], [x, y + height]].map(point => applyMatrix(matrix, point))
  }
  if (shape === 'circle') {
    const cx = Number(attrs.cx ?? 0)
    const cy = Number(attrs.cy ?? 0)
    const r = Number(attrs.r)
    if (![cx, cy, r].every(Number.isFinite)) throw new Error('circle has invalid cx/cy/r')
    return [[cx - r, cy - r], [cx + r, cy + r]].map(point => applyMatrix(matrix, point))
  }
  if (shape === 'ellipse') {
    const cx = Number(attrs.cx ?? 0)
    const cy = Number(attrs.cy ?? 0)
    const rx = Number(attrs.rx)
    const ry = Number(attrs.ry)
    if (![cx, cy, rx, ry].every(Number.isFinite)) throw new Error('ellipse has invalid cx/cy/rx/ry')
    return [[cx - rx, cy - ry], [cx + rx, cy + ry]].map(point => applyMatrix(matrix, point))
  }
  if (shape === 'line') {
    const values = [attrs.x1 ?? 0, attrs.y1 ?? 0, attrs.x2 ?? 0, attrs.y2 ?? 0].map(Number)
    if (!values.every(Number.isFinite)) throw new Error('line has invalid coordinates')
    return [[values[0], values[1]], [values[2], values[3]]].map(point => applyMatrix(matrix, point))
  }
  if (shape === 'polygon' || shape === 'polyline') {
    const values = numbers(attrs.points, `${shape} points`)
    if (values.length < 4 || values.length % 2 !== 0) throw new Error(`${shape} needs an even number of coordinates`)
    const points = []
    for (let i = 0; i < values.length; i += 2) points.push(applyMatrix(matrix, [values[i], values[i + 1]]))
    return points
  }
  return null
}

export function wordmarkInfo(elements) {
  const glyphs = elements.filter(element => typeof element.attrs.id === 'string' && element.attrs.id.startsWith('letter-'))
  if (glyphs.length === 0) return null
  const errors = []
  const letters = []
  for (const element of glyphs) {
    const match = element.attrs.id.match(/^letter-([a-z])(?:-\d+)?$/)
    if (!match) {
      errors.push(`unrecognised wordmark path id "${element.attrs.id}"`)
      continue
    }
    letters.push(match[1])
  }
  const word = letters.join('')
  const zCount = letters.filter(letter => letter === 'z').length
  if (word !== 'comfyrizz') errors.push(`wordmark ids spell "${word}", expected "comfyrizz"`)
  if (zCount !== 2) errors.push(`wordmark has ${zCount} z path(s), expected exactly 2`)
  if (!word.endsWith('zz') || word.endsWith('zzz')) errors.push('the two z letters must be final')
  if (letters.join(',') !== LETTER_ORDER.join(',')) {
    errors.push(`wordmark id order is ${letters.join(',') || '(none)'}, expected ${LETTER_ORDER.join(',')}`)
  }
  return { word, letters, zCount, ids: glyphs.map(element => element.attrs.id), errors }
}

export function symbolInfo(elements, ids = SYMBOL_IDS) {
  const paths = ids.map(id => idElement(elements, id))
  if (paths.some(path => path === undefined)) return null
  return {
    ids,
    paths,
    data: paths.map(path => (path.attrs.d || '').replace(/\s+/g, ' ').trim()),
  }
}

export function centringInfo(points, viewBox) {
  const [minX, minY, width, height] = viewBox
  const box = bbox(points)
  const centerX = (box.minX + box.maxX) / 2
  const centerY = (box.minY + box.maxY) / 2
  const offsetX = centerX - (minX + width / 2)
  const offsetY = centerY - (minY + height / 2)
  const limitX = width * 0.02
  const limitY = height * 0.02
  return {
    box,
    centerX,
    centerY,
    offsetX,
    offsetY,
    limitX,
    limitY,
    withinTolerance: Math.abs(offsetX) <= limitX + 1e-9 && Math.abs(offsetY) <= limitY + 1e-9,
  }
}

function checkForbiddenSource(source, elements, errors) {
  if (/<image\b/i.test(source)) errors.push('contains an <image> element')
  if (/<text\b|<tspan\b|<textPath\b/i.test(source)) errors.push('contains text elements; lettering must be paths')
  if (/data:/i.test(source)) errors.push('contains a data: URI or embedded bitmap data')
  if (/<(?:linear|radial)Gradient\b/i.test(source)) errors.push('contains a gradient element')
  if (/<filter\b/i.test(source)) errors.push('contains a filter element')
  if (/<fe[A-Z][A-Za-z]*\b/.test(source)) errors.push('contains a filter primitive')
  if (/@font-face|font-family|font\s*:/i.test(source)) errors.push('contains a font reference')
  if (/javascript:/i.test(source)) errors.push('contains a javascript: reference')

  const withoutNamespaces = source.replace(/\sxmlns(?::[\w.-]+)?\s*=\s*["']https?:\/\/www\.w3\.org\/[^"']*["']/g, '')
  if (/https?:\/\//i.test(withoutNamespaces)) errors.push('contains an http(s) reference')

  for (const element of elements) {
    const tag = element.name.toLowerCase()
    if (tag === 'image') errors.push(`<image> is not allowed (id ${element.attrs.id ?? 'n/a'})`)
    if (tag === 'text' || tag === 'tspan' || tag === 'textpath') errors.push(`<${element.name}> is not allowed`)
    if (tag === 'filter' || tag.startsWith('fe')) errors.push(`filter element <${element.name}> is not allowed`)
    if (tag === 'lineargradient' || tag === 'radialgradient') errors.push(`gradient element <${element.name}> is not allowed`)
    if (tag === 'font' || tag === 'font-face') errors.push(`font element <${element.name}> is not allowed`)
    for (const [name, value] of Object.entries(element.attrs)) {
      const lowerName = name.toLowerCase()
      const lowerValue = String(value).toLowerCase()
      const isNamespace = lowerName === 'xmlns' || lowerName.startsWith('xmlns:')
      if (lowerName === 'filter') errors.push(`filter attribute on <${element.name}> is not allowed`)
      if (lowerName.includes('font')) errors.push(`font attribute "${name}" on <${element.name}> is not allowed`)
      if (lowerValue.includes('data:')) errors.push(`data: URI in "${name}" on <${element.name}>`)
      if (lowerValue.includes('javascript:')) errors.push(`javascript: URI in "${name}" on <${element.name}>`)
      if (!isNamespace && /https?:\/\//i.test(lowerValue)) errors.push(`http(s) reference in "${name}" on <${element.name}>`)
      if (!isNamespace && lowerValue.trim().startsWith('//')) errors.push(`protocol-relative reference in "${name}" on <${element.name}>`)
      if ((lowerName === 'href' || lowerName === 'xlink:href') && !lowerValue.startsWith('#')) {
        errors.push(`external href on <${element.name}> is not allowed`)
      }
      if (lowerName === 'style' && /(?:filter|drop-shadow|text-shadow|gradient|url\(|@import)/.test(lowerValue)) {
        errors.push(`style on <${element.name}> uses a filter, shadow, gradient or external reference`)
      }
      if ((lowerName === 'fill' || lowerName === 'stroke') && lowerValue.includes('url(')) {
        errors.push(`url() paint reference in "${name}" on <${element.name}> is not allowed`)
      }
    }
  }
}

export function analyseSvg(file, source) {
  const parsed = parseXml(source)
  const errors = [...parsed.errors]
  const result = {
    file,
    source,
    elements: parsed.elements,
    root: parsed.rootIndex === null ? null : parsed.elements[parsed.rootIndex],
    viewBox: null,
    viewBoxError: null,
    points: [],
    pathCount: 0,
    wordmark: null,
    symbol: null,
    favicon: null,
    centring: null,
    errors,
  }

  checkForbiddenSource(source, parsed.elements, errors)
  if (!result.root || result.root.name !== 'svg') {
    errors.push('root element is not <svg>')
    return result
  }

  const rawViewBox = result.root.attrs.viewBox
  if (rawViewBox === undefined) {
    errors.push('missing viewBox')
  } else {
    const parts = rawViewBox.trim().split(/[\s,]+/).filter(Boolean).map(Number)
    if (parts.length !== 4 || parts.some(value => !Number.isFinite(value)) || parts[2] <= 0 || parts[3] <= 0) {
      result.viewBoxError = `invalid viewBox "${rawViewBox}"`
      errors.push(result.viewBoxError)
    } else {
      result.viewBox = parts
    }
  }

  const transforms = new Map()
  let allPoints = []
  for (const element of parsed.elements) {
    if (element.parent === null) continue
    try {
      if (element.name === 'path') {
        if (!element.attrs.d) throw new Error('path has no d attribute')
        result.pathCount += 1
        allPoints = allPoints.concat(pathPoints(element, matrixFor(parsed.elements, element.index, transforms)))
      } else {
        const points = shapePoints(element, matrixFor(parsed.elements, element.index, transforms))
        if (points) allPoints = allPoints.concat(points)
      }
    } catch (error) {
      errors.push(`${element.name}${element.attrs.id ? `#${element.attrs.id}` : ''}: ${error.message}`)
    }
  }
  result.points = allPoints

  if (result.viewBox) {
    const [minX, minY, width, height] = result.viewBox
    const eps = 1e-6
    const clipped = allPoints.filter(([x, y]) => x < minX - eps || x > minX + width + eps || y < minY - eps || y > minY + height + eps)
    if (clipped.length > 0) {
      const sample = clipped.slice(0, 3).map(([x, y]) => `(${Number(x.toFixed(3))}, ${Number(y.toFixed(3))})`).join(', ')
      errors.push(`${clipped.length} coordinate(s) outside viewBox ${result.viewBox.join(' ')}: ${sample}`)
    }
  }

  result.wordmark = wordmarkInfo(parsed.elements)
  if (result.wordmark) errors.push(...result.wordmark.errors.map(error => `wordmark: ${error}`))

  result.symbol = symbolInfo(parsed.elements)
  result.favicon = symbolInfo(parsed.elements, FAVICON_IDS)
  const square = result.viewBox && result.viewBox[2] === result.viewBox[3]
  if (square) {
    const mark = result.symbol ?? result.favicon
    if (mark) {
      let markPoints = []
      for (const path of mark.paths) {
        try {
          markPoints = markPoints.concat(pathPoints(path, matrixFor(parsed.elements, path.index, transforms)))
        } catch (error) {
          errors.push(`symbol${path.attrs.id ? `#${path.attrs.id}` : ''}: ${error.message}`)
        }
      }
      if (markPoints.length) {
        result.centring = centringInfo(markPoints, result.viewBox)
        if (!result.centring.withinTolerance) {
          errors.push(
            `symbol bbox centre is (${result.centring.centerX.toFixed(3)}, ${result.centring.centerY.toFixed(3)}), ` +
            `${result.centring.offsetX.toFixed(3)}/${result.centring.offsetY.toFixed(3)} from viewBox centre ` +
            `(limit ${result.centring.limitX.toFixed(3)}/${result.centring.limitY.toFixed(3)})`
          )
        }
      }
    }
  }
  return result
}

export function checkBrand(brandDir = BRAND_DIR) {
  const files = readdirSync(brandDir).filter(name => name.toLowerCase().endsWith('.svg')).sort()
  const results = files.map(name => analyseSvg(name, readFileSync(join(brandDir, name), 'utf8')))
  const errors = results.flatMap(result => result.errors.map(error => `${result.file}: ${error}`))
  const masters = results.filter(result => result.symbol)
  const section = results.find(result => result.favicon)

  if (masters.length === 0) errors.push('brand: no SVG contains the symbol paths')
  if (!results.some(result => result.file === 'favicon.svg' && result.favicon)) {
    errors.push('brand: favicon.svg is missing its simplified favicon-z paths')
  }
  if (masters.length > 0) {
    const reference = masters[0]
    for (const master of masters.slice(1)) {
      for (let i = 0; i < SYMBOL_IDS.length; i += 1) {
        if (master.symbol.data[i] !== reference.symbol.data[i]) {
          errors.push(`${master.file}: ${SYMBOL_IDS[i]} path data differs from ${reference.file}`)
        }
      }
    }
  }
  if (section && section.centring && !section.centring.withinTolerance) {
    errors.push(`${section.file}: favicon bbox is not centred in its square viewBox`)
  }
  return { files: results, errors, symbolMasters: masters.map(result => result.file) }
}

export function formatReport(report) {
  const lines = [`Checked ${report.files.length} brand SVG(s)`]
  for (const file of report.files) {
    const status = file.errors.length === 0 ? 'PASS' : `FAIL (${file.errors.length})`
    const bits = []
    if (file.viewBox) bits.push(`viewBox ${file.viewBox.join(' ')}`)
    if (file.pathCount) bits.push(`${file.pathCount} paths`)
    if (file.wordmark) bits.push(`word "${file.wordmark.word}"`)
    if (file.centring) {
      const c = file.centring
      bits.push(`centre offset ${c.offsetX.toFixed(2)},${c.offsetY.toFixed(2)} (limit ${c.limitX.toFixed(2)},${c.limitY.toFixed(2)})`)
    }
    lines.push(`  ${status} ${file.file}${bits.length ? ` - ${bits.join('; ')}` : ''}`)
    for (const error of file.errors) lines.push(`       - ${error}`)
  }
  lines.push(report.errors.length === 0 ? 'RESULT: PASS' : `RESULT: FAIL (${report.errors.length} error(s))`)
  return lines.join('\n')
}

if (process.argv[1] && import.meta.url === pathToFileURL(process.argv[1]).href) {
  const report = checkBrand()
  console.log(formatReport(report))
  process.exitCode = report.errors.length === 0 ? 0 : 1
}
