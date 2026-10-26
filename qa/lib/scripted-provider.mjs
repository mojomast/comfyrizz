// UX20: scripted model over the real OpenAI-compatible SSE transport.
//
// The server under test talks to this loopback process exactly as it would to a
// hosted provider, so the mounted `/api/agent/chat` route, the model adapter and
// the tool loop are all exercised. The script is fixed in advance; the provider
// never calls out, never needs a key, and records every request body so a test
// can assert what the agent was shown (tools, system prompt, scope blocks).
//
// A turn is `{ tool: name, args }` (one tool call) or `{ text }` (final answer).
// After the script ends the provider answers with `finalText`, or, with
// `strict: true`, fails the request so an unexpected extra model call is visible.
import { createServer } from 'node:http';

const safeName = name => name.replace(/[^a-zA-Z0-9_-]/g, '_');
const sse = (response, payload) => response.write(`data: ${JSON.stringify(payload)}\n\n`);

export function startScriptedProvider({ turns = [], finalText = 'Done.', strict = false, model = 'scripted' } = {}) {
  let script = [...turns];
  let finalAnswer = finalText;
  let index = 0;
  const requests = [];
  const emitted = [];
  const server = createServer((request, response) => {
    let raw = '';
    request.on('data', chunk => { raw += chunk; });
    request.on('end', () => {
      if (request.url?.endsWith('/models')) {
        response.writeHead(200, { 'content-type': 'application/json' });
        response.end(JSON.stringify({ data: [{ id: model }] }));
        return;
      }
      let body = {};
      try { body = JSON.parse(raw || '{}'); } catch { /* recorded as empty */ }
      requests.push({ url: request.url, body });
      const turn = script[index];
      index += 1;
      if (!turn && strict) {
        response.writeHead(500, { 'content-type': 'application/json' });
        response.end(JSON.stringify({ error: { message: 'QA scripted provider: script exhausted (strict)' } }));
        return;
      }
      response.writeHead(200, { 'content-type': 'text/event-stream', 'cache-control': 'no-cache' });
      if (turn?.tool) {
        emitted.push({ name: turn.tool, args: turn.args ?? {} });
        sse(response, { choices: [{ delta: { tool_calls: [{ index: 0, id: `qa_${index}`, type: 'function', function: { name: safeName(turn.tool), arguments: JSON.stringify(turn.args ?? {}) } }] }, finish_reason: null }] });
        sse(response, { choices: [{ delta: {}, finish_reason: 'tool_calls' }] });
      } else {
        sse(response, { choices: [{ delta: { content: turn?.text ?? finalAnswer }, finish_reason: 'stop' }] });
      }
      sse(response, { choices: [], usage: { prompt_tokens: 40, completion_tokens: 12, total_tokens: 52 } });
      response.write('data: [DONE]\n\n');
      response.end();
    });
  });
  return new Promise(resolve => {
    server.listen(0, '127.0.0.1', () => {
      resolve({
        url: `http://127.0.0.1:${server.address().port}/v1`,
        model,
        requests,
        emitted,
        get modelCalls() { return requests.length; },
        /** Tool names offered in the most recent request. */
        offeredTools() {
          const last = requests.at(-1)?.body;
          return (last?.tools ?? []).map(tool => tool.function?.name ?? tool.name);
        },
        /** Replace the script for the next turn; resets the cursor. */
        script(nextTurns, nextFinal = finalAnswer) { script = [...nextTurns]; finalAnswer = nextFinal; index = 0; },
        close: () => new Promise(done => server.close(() => done())),
      });
    });
  });
}
