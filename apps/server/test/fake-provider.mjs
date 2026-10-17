// A second OpenAI-compatible provider for tests: it replays a list of agent
// tool calls over the real SSE transport (the same framing a live provider
// uses), then answers with a short final text. No network, no GPU, no key.
import { createServer } from 'node:http';

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
export function replayProvider(calls, { finalText = 'The package draft is ready.', model = 'local-compatible' } = {}) {
  let index = 0;
  const server = createServer((request, response) => {
    let raw = '';
    request.on('data', chunk => {
      raw += chunk;
    });
    request.on('end', () => {
      if (request.url?.endsWith('/models')) {
        response.writeHead(200, { 'content-type': 'application/json' });
        response.end(JSON.stringify({ data: [{ id: model }] }));
        return;
      }
      response.writeHead(200, { 'content-type': 'text/event-stream', 'cache-control': 'no-cache' });
      const call = index < calls.length ? calls[index] : null;
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
        close: () => new Promise(done => server.close(() => done())),
      });
    });
  });
}
