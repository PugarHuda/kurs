// CORS preflight for the public GET endpoints. A browser sends OPTIONS before a GET that
// carries a non-simple header (X-PAYMENT for x402, or any custom header a dapp adds);
// without this answer the browser blocks the request.
export function preflight() {
  return new Response(null, {
    status: 204,
    headers: {
      "access-control-allow-origin": "*",
      "access-control-allow-methods": "GET, OPTIONS",
      "access-control-allow-headers": "content-type, x-payment",
      "access-control-expose-headers": "x-payment-response",
      "access-control-max-age": "86400",
    },
  });
}
