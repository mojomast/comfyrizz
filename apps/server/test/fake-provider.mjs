// A second OpenAI-compatible provider for tests: it replays a list of agent
// tool calls over the real SSE transport (the same framing a live provider
// uses), then answers with a short final text. No network, no GPU, no key.
import { createServer } from 'node:http';

/** Add an explicit planned plate to a scripted native-graphics film. No GPU service runs. */
export function withPlannedPlate(calls, sceneId = null) {
  let added = false;
  return calls.flatMap(call => {
    if (added || call?.name !== 'storyboard.propose') return [call];
    added = true;
    const id = sceneId ?? 's_comfy_plate';
    const proposal = structuredClone(call);
    if (!sceneId) proposal.args.scenes.push({ id, layout: 'title', copy: { headline: 'Editorial context' }, preferredFrames: 90 });
    return [proposal, { name: 'assets.generate_image', args: { scene_id: id, kind: 'illustration', intent: 'A relevant editorial backdrop supporting the film subject' } }, visiblePlateCall(id)];
  });
}

export function visiblePlateCall(sceneId) {
  return request => {
    const result = request.messages.filter(message => message.role === 'tool').map(message => {
      try { const body = JSON.parse(message.content); return body.result ?? body; } catch { return null; }
    }).findLast(body => body?.asset?.id && body?.scene_id === sceneId);
    if (!result) throw new Error(`No image tool result for ${sceneId}`);
    return { name: 'storyboard.edit', args: { scene_id: sceneId, patch: { background: { asset: result.asset.id }, foreground: [] } } };
  };
}

function writeSse(response, payload) {
  response.write(`data: ${JSON.stringify(payload)}\n\n`);
}

/** OpenAI-compatible tool names are restricted; mirror the adapter's mapping. */
function safeName(name) {
  return name.replace(/[^a-zA-Z0-9_-]/g, '_');
}

/**
 * Start a loopback provider that returns one scripted tool call per request and
 * a final text turn once the script is exhausted.
 * @param {Array<{ name: string, args: unknown }>} calls
 * @returns {Promise<{ url: string, calls: number, close: () => Promise<void> }>}
 */
export function replayProvider(initialCalls, { finalText = 'The package draft is ready.', model = 'local-compatible', svgText, svgStatus, onSvgRequest, svgHang = false } = {}) {
  let calls = initialCalls;
  let index = 0;
  let admissionRefusals = 0;
  const requests = [];
  const server = createServer((request, response) => {
    let raw = '';
    request.on('data', chunk => {
      raw += chunk;
    });
    request.on('end', () => {
      if (raw) requests.push(JSON.parse(raw));
      if (request.url?.endsWith('/models')) {
        response.writeHead(200, { 'content-type': 'application/json' });
        response.end(JSON.stringify({ data: [{ id: model }] }));
        return;
      }
      if (admissionRefusals > 0) {
        admissionRefusals -= 1;
        response.writeHead(429, { 'content-type': 'application/json' });
        response.end(JSON.stringify({ error: { type: 'server_error', message: '[ttft_admission_refused] the cell is at capacity; retry shortly (after 3 s)' } }));
        return;
      }
      const svgRequest = raw && JSON.parse(raw).messages?.some(message => message.role === 'system' && message.content?.includes('one standalone SVG document'));
      if (svgRequest) onSvgRequest?.();
      if (svgHang && svgRequest) return;
      if (svgStatus && svgRequest) {
        response.writeHead(svgStatus, { 'content-type': 'application/json' });
        response.end(JSON.stringify({ error: { message: 'SVG provider unavailable' } }));
        return;
      }
      response.writeHead(200, { 'content-type': 'text/event-stream', 'cache-control': 'no-cache' });
      if (svgText !== undefined && svgRequest) {
        writeSse(response, { choices: [{ delta: { content: svgText }, finish_reason: 'stop' }] });
        writeSse(response, { choices: [], usage: { prompt_tokens: 13, completion_tokens: 7, total_tokens: 20 } });
        response.write('data: [DONE]\n\n');
        response.end();
        return;
      }
      const scripted = index < calls.length ? calls[index] : null;
      const call = typeof scripted === 'function' ? scripted(JSON.parse(raw)) : scripted;
      index += 1;
      if (call) {
        writeSse(response, {
          choices: [
            {
              delta: {
                tool_calls: [
                  {
                    index: 0,
                    id: `fake_${index}`,
                    type: 'function',
                    function: { name: safeName(call.name), arguments: JSON.stringify(call.args ?? {}) },
                  },
                ],
              },
              finish_reason: null,
            },
          ],
        });
        writeSse(response, { choices: [{ delta: {}, finish_reason: 'tool_calls' }] });
        writeSse(response, { choices: [], usage: { prompt_tokens: 64, completion_tokens: 24, total_tokens: 88 } });
      } else {
        writeSse(response, { choices: [{ delta: { content: finalText }, finish_reason: 'stop' }] });
        writeSse(response, { choices: [], usage: { prompt_tokens: 32, completion_tokens: 8, total_tokens: 40 } });
      }
      response.write('data: [DONE]\n\n');
      response.end();
    });
  });
  return new Promise(resolve => {
    server.listen(0, '127.0.0.1', () => {
      resolve({
        url: `http://127.0.0.1:${server.address().port}/v1`,
        get calls() {
          return index;
        },
        requests,
        refuseNext(count = 1) { admissionRefusals = count; },
        /** C13: reuse the same loopback URL for a second `/api/agent` run with a new script. */
        setCalls(nextCalls) {
          calls = nextCalls;
          index = 0;
        },
        close: () => new Promise(done => server.close(() => done())),
      });
    });
  });
}
