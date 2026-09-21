export const jsonResponse = (body: Record<string, unknown>, status: number, headers?: HeadersInit): Response => {
  const responseHeaders = new Headers({
    "Content-Type": "application/json; charset=utf-8",
    "Cache-Control": "no-store",
    "X-Content-Type-Options": "nosniff",
  });
  if (headers) {
    new Headers(headers).forEach((value, key) => {
      responseHeaders.set(key, value);
    });
  }
  return new Response(JSON.stringify(body), { status, headers: responseHeaders });
};

export const requestError = (code: "INVALID_REQUEST" | "INVALID_PAYLOAD", status = 400): Response =>
  jsonResponse({ ok: false, code }, status);
