import { sendWebResponse, toWebRequest } from "../src/production/node-http.mjs";

export function createHandler({ loadApp = () => import('../src/production/app.mjs') } = {}) {
let app;
return async function handler(req, res) {
  try {
    if (!app) { const { createProductionApp } = await loadApp(); app = createProductionApp(); }
    let request = await toWebRequest(req);
    const url = new URL(request.url), routed = url.searchParams.get("__cms_path");
    if (routed) {
      url.pathname = routed;
      url.searchParams.delete("__cms_path");
      request = new Request(url, request);
    }
    await sendWebResponse(res, await app(request));
  } catch (error) {
    console.error("Resources function failure", { name: error?.name, code: error?.code });
    res.statusCode = error?.status === 413 ? 413 : 500;
    res.setHeader("Content-Type", "application/json");
    res.setHeader("Cache-Control", "no-store");
    res.end(JSON.stringify({ error: res.statusCode === 413 ? "Request too large" : "Service unavailable" }));
  }
}
}
export default createHandler();
