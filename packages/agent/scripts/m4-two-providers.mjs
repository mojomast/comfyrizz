#!/usr/bin/env node
// M4 two-provider check: the same agent loop against OpenCode Go (live) and a
// local OpenAI-compatible custom endpoint. The local endpoint is a deterministic
// test provider; it is not a second cloud vendor.
import { createServer } from 'node:http';
import { resolveProvider } from '../../llm/dist/src/presets.js';
import { createOpenAICompatibleModel } from '../../llm/dist/src/openai-compatible.js';
import { createToolset, runAgent } from '../dist/src/index.js';

function sse(res, payload) {
  res.writeHead(200, { 'content-type': 'text/event-stream', 'cache-control': 'no-cache' });
  res.write(`data: ${JSON.stringify(payload)}\n\ndata: [DONE]\n\n`);
  res.end();
}

const server = createServer((req, res) => {
  let raw = '';
  req.on('data', chunk => { raw += chunk; });
  req.on('end', () => {
    if (req.url.endsWith('/models')) {
      res.writeHead(200, { 'content-type': 'application/json' });
      res.end(JSON.stringify({ data: [{ id: 'local-compatible' }] }));
      return;
    }
    const body = JSON.parse(raw || '{}');
    const hasToolResult = body.messages?.some(message => message.role === 'tool');
    if (!hasToolResult) {
      res.writeHead(200, { 'content-type': 'text/event-stream' });
      const calls = [
        { index: 0, id: 'l1', type: 'function', function: { name: 'assets_route', arguments: '{"scene_id":"s1","kind":"icon","need":"rocket icon"}' } },
        { index: 1, id: 'l2', type: 'function', function: { name: 'assets_route', arguments: '{"scene_id":"s2","kind":"illustration","need":"nebula illustration"}' } },
      ];
      res.write(`data: ${JSON.stringify({ choices: [{ delta: { tool_calls: calls }, finish_reason: 'tool_calls' }] })}\n\n`);
      res.write('data: [DONE]\n\n');
      res.end();
    } else {
      sse(res, { choices: [{ delta: { content: 'local provider routed both assets' }, finish_reason: 'stop' }] });
    }
  });
});
await new Promise(resolve => server.listen(0, '127.0.0.1', resolve));
const { port } = server.address();
const config = resolveProvider('custom', { baseUrl: `http://127.0.0.1:${port}/v1`, apiKey: null, model: 'local-compatible' });
const result = await runAgent({
  model: createOpenAICompatibleModel(config),
  brief: 'route an icon and an illustration',
  tools: createToolset(),
  sessionId: 'm4-local',
  maxSteps: 3,
});
server.close();
const routes = result.toolCalls.map(call => call.result?.tool).filter(Boolean);
console.log(JSON.stringify({ provider: 'custom-local', ok: result.ok, text: result.text, routes }, null, 2));
process.exit(result.ok && routes.includes('assets.generate_svg') && routes.includes('assets.generate_image') ? 0 : 1);
