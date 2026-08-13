import { execFile } from "node:child_process";
import { readFile } from "node:fs/promises";
import http from "node:http";
import path from "node:path";
import { promisify } from "node:util";

const execFileAsync = promisify(execFile);
const root = process.cwd();
const dist = path.join(root, "dist");
const chrome = "/Applications/Google Chrome.app/Contents/MacOS/Google Chrome";
const mimeTypes = {
  ".css": "text/css",
  ".html": "text/html",
  ".js": "text/javascript",
  ".svg": "image/svg+xml",
};

const diagnosticHtml = `<!doctype html>
<html><head><meta name="viewport" content="width=device-width,initial-scale=1"><style>
html,body,iframe{width:100%;height:100%;margin:0;border:0}
</style></head><body><iframe src="/"></iframe><script>
const frame=document.querySelector("iframe");
frame.addEventListener("load",()=>setTimeout(()=>{
  const doc=frame.contentDocument;
  const win=frame.contentWindow;
  const selectors=[".workspace",".workspace-grid",".workspace-main",".flow-canvas",".flow-track-scroll",".flow-track",".timeline-panel",".inspector-panel"];
  const boxes=Object.fromEntries(selectors.map(selector=>{
    const element=doc.querySelector(selector);
    const rect=element.getBoundingClientRect();
    const style=win.getComputedStyle(element);
    return [selector,{left:Math.round(rect.left),right:Math.round(rect.right),top:Math.round(rect.top),bottom:Math.round(rect.bottom),width:Math.round(rect.width),clientWidth:element.clientWidth,scrollWidth:element.scrollWidth,display:style.display,position:style.position,flexDirection:style.flexDirection,overflowX:style.overflowX}];
  }));
  const result={viewport:{width:doc.documentElement.clientWidth,height:doc.documentElement.clientHeight,scrollWidth:doc.documentElement.scrollWidth},boxes};
  document.body.innerHTML="";
  const output=document.createElement("pre");
  output.id="result";
  output.textContent=JSON.stringify(result);
  document.body.append(output);
},500));
</script></body></html>`;

const server = http.createServer(async (request, response) => {
  try {
    const pathname = new URL(request.url ?? "/", "http://127.0.0.1").pathname;
    if (pathname === "/layout-diagnostic") {
      response.writeHead(200, { "content-type": "text/html" });
      response.end(diagnosticHtml);
      return;
    }

    const relativePath = pathname === "/" ? "index.html" : pathname.slice(1);
    if (relativePath.includes("..")) throw new Error("Invalid path");
    const filePath = path.join(dist, relativePath);
    const content = await readFile(filePath);
    response.writeHead(200, {
      "content-type": mimeTypes[path.extname(filePath)] ?? "application/octet-stream",
    });
    response.end(content);
  } catch {
    response.writeHead(404);
    response.end("Not found");
  }
});

await new Promise((resolve) => server.listen(0, "127.0.0.1", resolve));
const address = server.address();
if (!address || typeof address === "string") throw new Error("No server address");

const viewports = [
  [1920, 1080],
  [1440, 900],
  [1360, 800],
  [1024, 768],
  [390, 844],
];

try {
  for (const [width, height] of viewports) {
    const { stdout } = await execFileAsync(
      chrome,
      [
        "--headless=new",
        "--disable-gpu",
        "--hide-scrollbars",
        `--window-size=${width},${height}`,
        "--virtual-time-budget=3000",
        "--dump-dom",
        `http://127.0.0.1:${address.port}/layout-diagnostic`,
      ],
      { maxBuffer: 10 * 1024 * 1024 },
    );
    const match = stdout.match(/<pre id="result">([^<]+)<\/pre>/);
    if (!match) throw new Error(`No layout result for ${width}x${height}`);
    const result = JSON.parse(match[1]);
    const boxes = result.boxes;
    const desktop = width > 1380;
    const checks = {
      noPageOverflow: result.viewport.scrollWidth === result.viewport.width,
      canvasContained: boxes[".flow-canvas"].right <= boxes[".workspace-main"].right + 1,
      trackContained: boxes[".flow-track-scroll"].right <= boxes[".workspace-main"].right + 1,
      internalTrackScroll:
        width <= 640
          ? boxes[".flow-track-scroll"].scrollWidth <= boxes[".flow-track-scroll"].clientWidth + 1
          : boxes[".flow-track-scroll"].scrollWidth > boxes[".flow-track-scroll"].clientWidth,
      inspectorSeparated: desktop
        ? boxes[".inspector-panel"].left >= boxes[".workspace-main"].right + 20
        : boxes[".inspector-panel"].top >= boxes[".workspace-main"].bottom + 20,
      inspectorMode: desktop
        ? boxes[".inspector-panel"].position === "sticky"
        : boxes[".inspector-panel"].position === "static",
    };
    console.log(JSON.stringify({ viewport: `${width}x${height}`, checks, boxes }));
    if (Object.values(checks).some((passed) => !passed)) process.exitCode = 1;
  }
} finally {
  await new Promise((resolve, reject) =>
    server.close((error) => (error ? reject(error) : resolve())),
  );
}
