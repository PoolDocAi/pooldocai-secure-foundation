export async function toWebRequest(req, maximum = 4_500_000) {
  const origin = `https://${req.headers.host || "invalid.local"}`;
  const chunks = [];
  let size = 0;
  for await (const chunk of req) {
    size += chunk.length;
    if (size > maximum) throw Object.assign(new Error("Request too large"), { status: 413 });
    chunks.push(chunk);
  }
  const body = chunks.length ? Buffer.concat(chunks) : undefined;
  return new Request(new URL(req.url || "/", origin), {
    method: req.method, headers: req.headers,
    ...(body && !["GET", "HEAD"].includes(req.method) ? { body, duplex: "half" } : {}),
  });
}

export async function sendWebResponse(res, response) {
  res.statusCode = response.status;
  for (const [name, value] of response.headers) if (name !== "set-cookie") res.setHeader(name, value);
  const cookies = response.headers.getSetCookie?.() || [];
  if (cookies.length) res.setHeader("Set-Cookie", cookies);
  res.end(Buffer.from(await response.arrayBuffer()));
}
