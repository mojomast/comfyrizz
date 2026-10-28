// AI2: Dagre 3.1.1 technical-flow geometry.
//
// `copy.items` remain the editable node labels. The graph is laid out once and
// cached by (labels, frame size, portrait, seed); frames only move the reveal
// and packets along the precomputed point lists. Portrait uses top-to-bottom
// ranks, landscape left-to-right. There is no axis `direction` option: the
// aspect ratio chooses orientation so a portrait reflow is real, not a crop.

import dagre from '@dagrejs/dagre';
import { diagramState } from '../diagram-model.js';
import { captionSafeTop } from './geometry.js';
import { clamp, seededRandom } from './model.js';

const PLAN_CACHE = new Map();
const MAX_CACHE = 32;

/**
 * @typedef {{id:string,label:string,index:number,x:number,y:number,w:number,h:number}} FlowNode
 * @typedef {{key:string,from:string,to:string,points:Array<{x:number,y:number}>,path:string,start:number,duration:number,offset:number,arrow:{x:number,y:number,angle:number}}} FlowEdge
 * @typedef {{nodes:FlowNode[],edges:FlowEdge[],width:number,height:number,portrait:boolean,area:{x:number,y:number,w:number,h:number}}} FlowPlan
 */

/**
 * @param {{items:string[],width:number,height:number,scene:any,seed?:number,cues?:number[],fps?:number,area?:{x:number,y:number,w:number,h:number}|null,rankdir?:'TB'|'LR'|null}} options
 * @returns {FlowPlan}
 */
export function technicalFlowPlan({ items, width, height, scene, seed = 1, cues = [], fps = 30, area: areaOverride = null, rankdir: rankdirOverride = null }) {
  const labels = items.map(item => String(item));
  const rankdir = rankdirOverride ?? (height > width ? 'TB' : 'LR');
  const key = `${width}x${height}|${rankdir}|${seed}|${areaOverride ? `${areaOverride.x},${areaOverride.y},${areaOverride.w},${areaOverride.h}` : ''}|${labels.join('\u0001')}|${cues.join(',')}`;
  const cached = PLAN_CACHE.get(key);
  if (cached) return cached;
  const portrait = rankdir === 'TB';
  const bottom = captionSafeTop(width, height);
  const defaultArea = portrait
    ? {
        x: width * 0.1,
        y: Math.max(height * 0.22, 210),
        w: width * 0.8,
        h: Math.max(220, bottom - Math.max(height * 0.22, 210) - height * 0.03),
      }
    : {
        x: width * 0.075,
        y: Math.max(height * 0.24, 190),
        w: width * 0.85,
        h: Math.max(200, bottom - Math.max(height * 0.24, 190) - height * 0.04),
      };
  const area = areaOverride ?? defaultArea;
  const count = Math.max(1, labels.length);
  const nodeW = portrait
    ? Math.max(120, Math.min(area.w * 0.9, width * 0.74))
    : Math.max(100, Math.min(320, area.w / Math.max(1, count + 0.25)));
  const nodeH = portrait
    ? Math.max(40, Math.min(140, (area.h - Math.max(10, area.h * 0.03) * (count - 1)) / Math.max(1, count)))
    : Math.max(64, Math.min(170, area.h * 0.32));
  const graph = new dagre.graphlib.Graph({ multigraph: false });
  graph.setGraph({
    rankdir,
    align: 'UL',
    nodesep: portrait ? Math.max(10, Math.min(44, area.w * 0.05)) : Math.max(22, height * 0.026),
    ranksep: portrait ? Math.max(14, Math.min(52, area.h * 0.05)) : Math.max(36, width * 0.024),
    marginx: area.x,
    marginy: area.y,
    ranker: 'network-simplex',
  });
  graph.setDefaultEdgeLabel(() => ({}));
  labels.forEach((label, index) => {
    graph.setNode(`n${index}`, { width: nodeW, height: nodeH, label });
  });
  for (let index = 0; index < labels.length - 1; index += 1) {
    graph.setEdge(`n${index}`, `n${index + 1}`);
  }
  dagre.layout(graph);
  const duration = Math.max(12, Math.round(fps * 1.35));
  const random = seededRandom(seed, 91);
  const nodes = labels.map((label, index) => {
    const point = graph.node(`n${index}`) ?? { x: area.x + nodeW / 2, y: area.y + nodeH / 2, width: nodeW, height: nodeH };
    const x = clamp(point.x - point.width / 2, area.x, area.x + area.w - point.width);
    const y = clamp(point.y - point.height / 2, area.y, area.y + area.h - point.height);
    return { id: `n${index}`, label, index, x, y, w: point.width, h: point.height };
  });
  // Dagre aligns to the upper-left of the available area. Center the completed
  // graph vertically so process scenes use the frame instead of crowding the top.
  const graphTop = Math.min(...nodes.map(node => node.y));
  const graphBottom = Math.max(...nodes.map(node => node.y + node.h));
  const offsetY = area.y + area.h / 2 - (graphTop + graphBottom) / 2;
  for (const node of nodes) node.y += offsetY;
  const edges = [];
  for (let index = 0; index < nodes.length - 1; index += 1) {
    const fromNode = nodes[index];
    const toNode = nodes[index + 1];
    const dagreEdge = graph.edge(`n${index}`, `n${index + 1}`);
    const points = normalizePoints(dagreEdge?.points, fromNode, toNode).map(point => ({ ...point, y: point.y + offsetY }));
    const path = smoothPolyline(points);
    const arrow = arrowAt(points);
    const start = cues.length > index ? Math.round(cues[index] * fps) : Math.round(fps * 0.7 + index * Math.max(1, fps * 1.1));
    edges.push({
      key: `${fromNode.id}-${toNode.id}`,
      from: fromNode.id,
      to: toNode.id,
      points,
      path,
      start,
      duration,
      offset: random(),
      arrow,
    });
  }
  const plan = { nodes, edges, width, height, portrait, area };
  if (PLAN_CACHE.size >= MAX_CACHE) PLAN_CACHE.clear();
  PLAN_CACHE.set(key, plan);
  return plan;
}

/**
 * @param {{x:number,y:number}[]|undefined} points
 * @param {FlowNode} fromNode
 * @param {FlowNode} toNode
 * @returns {Array<{x:number,y:number}>}
 */
function normalizePoints(points, fromNode, toNode) {
  if (Array.isArray(points) && points.length >= 2) {
    return points.map(point => ({ x: point.x, y: point.y }));
  }
  return [
    { x: fromNode.x + fromNode.w / 2, y: fromNode.y + fromNode.h / 2 },
    { x: toNode.x + toNode.w / 2, y: toNode.y + toNode.h / 2 },
  ];
}

/**
 * A smooth connector through Dagre's point list. Each interior point becomes a
 * quadratic corner so connectors look routed rather than zig-zag.
 * @param {Array<{x:number,y:number}>} points
 * @returns {string}
 */
export function smoothPolyline(points) {
  if (points.length === 0) return '';
  if (points.length === 1) return `M${round(points[0].x)},${round(points[0].y)}`;
  let path = `M${round(points[0].x)},${round(points[0].y)}`;
  for (let index = 1; index < points.length - 1; index += 1) {
    const current = points[index];
    const next = points[index + 1];
    const mid = { x: (current.x + next.x) / 2, y: (current.y + next.y) / 2 };
    path += ` Q${round(current.x)},${round(current.y)} ${round(mid.x)},${round(mid.y)}`;
  }
  const last = points[points.length - 1];
  path += ` L${round(last.x)},${round(last.y)}`;
  return path;
}

/** @param {number} value */
function round(value) {
  return Math.round(value * 100) / 100;
}

/**
 * End point and tangent for the arrowhead.
 * @param {Array<{x:number,y:number}>} points
 */
export function arrowAt(points) {
  const last = points[points.length - 1] ?? { x: 0, y: 0 };
  const previous = points[points.length - 2] ?? last;
  return { x: last.x, y: last.y, angle: Math.atan2(last.y - previous.y, last.x - previous.x) };
}

/**
 * Point at a fraction of a polyline, used for traveling packets.
 * @param {Array<{x:number,y:number}>} points
 * @param {number} t 0..1
 * @returns {{x:number,y:number}}
 */
export function pointOnPolyline(points, t) {
  if (points.length === 0) return { x: 0, y: 0 };
  if (points.length === 1) return { ...points[0] };
  const target = clamp(t) * polylineLength(points);
  let walked = 0;
  for (let index = 1; index < points.length; index += 1) {
    const a = points[index - 1];
    const b = points[index];
    const length = Math.hypot(b.x - a.x, b.y - a.y);
    if (walked + length >= target) {
      const local = length === 0 ? 0 : (target - walked) / length;
      return { x: a.x + (b.x - a.x) * local, y: a.y + (b.y - a.y) * local };
    }
    walked += length;
  }
  return { ...points[points.length - 1] };
}

/** @param {Array<{x:number,y:number}>} points */
export function polylineLength(points) {
  let length = 0;
  for (let index = 1; index < points.length; index += 1) {
    length += Math.hypot(points[index].x - points[index - 1].x, points[index].y - points[index - 1].y);
  }
  return length;
}

/**
 * Bounded analytic packet progress: 0 before the edge starts, then a periodic
 * 0..1 position. Time is frames, never wall-clock.
 * @param {{frame:number,start:number,duration:number,offset?:number}} options
 * @returns {number|null}
 */
export function packetProgress({ frame, start, duration, offset = 0 }) {
  if (frame < start) return null;
  const span = Math.max(1, duration);
  return ((frame - start) / span + offset) % 1;
}

/**
 * Node reveal/active state. Reuses the diagram cue model so `cue_seconds`
 * means the same thing in flow and in the existing motion diagram.
 * @param {{frame:number,fps:number,sceneFrames:number,count:number,cues?:number[]}} options
 */
export function flowState(options) {
  return diagramState(options);
}

/** Test/diagnostic hook: number of cached Dagre plans. */
export function flowCacheSize() {
  return PLAN_CACHE.size;
}
