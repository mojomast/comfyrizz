// E1: the resvg shim. Reads {"svg","width","height"} as JSON on stdin, renders with the
// resvg-js that Pi's packages/vector already depends on (imported by absolute path - ESM
// ignores NODE_PATH), writes a PNG and a raw RGBA buffer, and prints their paths as JSON.
//
// Raw RGBA is what the Python control maps are computed from, so this package needs no image
// library at all. Nothing here touches the network.
const modulePath = process.argv[2];
if (!modulePath) {
  process.stderr.write("usage: node _resvg.mjs <path-to-@resvg/resvg-js/index.js>\n");
  process.exit(2);
}

const chunks = [];
for await (const chunk of process.stdin) chunks.push(chunk);

let request;
try {
  request = JSON.parse(Buffer.concat(chunks).toString("utf8"));
} catch (error) {
  process.stderr.write(`cannot read the request: ${error.message}\n`);
  process.exit(2);
}

const { Resvg } = await import(modulePath);

const resvg = new Resvg(request.svg, {
  fitTo: { mode: "width", value: Number(request.width) || 1024 },
  background: request.background || "rgba(0,0,0,0)",
  font: { loadSystemFonts: false },
});
const png = resvg.render();
const width = png.width;
const height = request.height && Number(request.height) > 0 ? Math.min(Number(request.height), png.height) : png.height;
const pixels = png.pixels; // RGBA, premultiplied as resvg returns it

// crop to the requested height if it is smaller (fitTo scales by width)
const stride = width * 4;
const cropped = height === png.height ? pixels : pixels.subarray(0, stride * height);

const os = await import("node:os");
const fs = await import("node:fs");
const path = await import("node:path");
const dir = fs.mkdtempSync(path.join(os.tmpdir(), "comfyrizz-resvg-"));
const pngPath = path.join(dir, "render.png");
const rgbaPath = path.join(dir, "render.rgba");
fs.writeFileSync(pngPath, png.asPng());
fs.writeFileSync(rgbaPath, Buffer.from(cropped));

process.stdout.write(
  JSON.stringify({
    png: pngPath,
    rgba: rgbaPath,
    width,
    height,
    bytes: fs.statSync(rgbaPath).size,
    renderer: "resvg-js",
  }),
);
