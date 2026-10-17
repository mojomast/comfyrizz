// A local stand-in for `comfy-api-proxy` + ComfyUI, used only by the BYO backend tests.
// It answers the v2 surface Comfyrizz calls, /system_stats, /object_info, and logs cancels.
import { createServer } from "node:http";
import { appendFileSync } from "node:fs";

const argv = process.argv.slice(2);
const port = Number(argv[argv.indexOf("--port") + 1] || 0);
const logPath = process.env.V2_STUB_LOG || "./v2-stub.log";
const nodes = process.env.V2_STUB_NODES ? process.env.V2_STUB_NODES.split(",") : ["KSampler", "LoadImage", "SaveImage"];
const models = process.env.V2_STUB_MODELS ? process.env.V2_STUB_MODELS.split(",") : ["tiny.safetensors"];

const server = createServer((request, response) => {
  const url = new URL(request.url, `http://127.0.0.1:${port}`);
  const send = (payload, status = 200) => {
    const body = JSON.stringify(payload);
    response.writeHead(status, { "content-type": "application/json" });
    response.end(body);
  };
  if (url.pathname === "/api/v2/jobs" && request.method === "GET") return send({ jobs: [] });
  if (url.pathname.endsWith("/cancel") && request.method === "POST") {
    appendFileSync(logPath, `${JSON.stringify({ cancel: url.pathname, at: Date.now() })}\n`);
    return send({ id: url.pathname.split("/")[4], status: "canceled" });
  }
  if (url.pathname === "/system_stats") return send({ system: { comfyui_version: "0.41.0-stub" }, devices: [{ name: "stub", vram_total: 1024 ** 3 * 96, vram_free: 1024 ** 3 * 80 }] });
  if (url.pathname === "/object_info") {
    const info = {};
    nodes.forEach((node, index) => {
      info[node] = { input: { required: { model_name: index === 0 ? [models] : [["tiny.safetensors"]] } }, output: ["MODEL"] };
    });
    return send(info);
  }
  send({ error: { code: "not_found", message: url.pathname } }, 404);
});
server.listen(port, "127.0.0.1", () => {
  // report the *bound* port so `--port 0` lets a test allocate a free one
  process.stdout.write(`v2-stub listening on ${server.address().port}\n`);
});
process.on("SIGTERM", () => server.close(() => process.exit(0)));
