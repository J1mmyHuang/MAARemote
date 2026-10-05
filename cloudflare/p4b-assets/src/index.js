const CONTENT_TYPES = Object.freeze({
  "/sw.js": "text/javascript; charset=utf-8",
  "/manifest.webmanifest": "application/manifest+json; charset=utf-8",
});

function withContentType(response, contentType) {
  const headers = new Headers(response.headers);
  headers.set("Content-Type", contentType);
  return new Response(response.body, {
    status: response.status,
    statusText: response.statusText,
    headers,
  });
}

export default {
  async fetch(request, env) {
    const response = await env.ASSETS.fetch(request);
    const contentType = CONTENT_TYPES[new URL(request.url).pathname];
    return contentType ? withContentType(response, contentType) : response;
  },
};
