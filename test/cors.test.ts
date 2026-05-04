import { expect, test } from "bun:test";

const BASE_URL = process.env.WORKER_URL;

if (!BASE_URL) {
  throw new Error(
    "Set WORKER_URL to the deployed worker's base URL.\n" +
      "  bun run deploy             # prints { url: ... }\n" +
      "Then put the URL in .env (bun auto-loads it):\n" +
      "  WORKER_URL=https://...workers.dev",
  );
}

const ORIGIN = "https://example.test";

test("OPTIONS preflight carries Access-Control-Allow-Origin", async () => {
  const res = await fetch(`${BASE_URL}/hello`, {
    method: "OPTIONS",
    headers: {
      Origin: ORIGIN,
      "Access-Control-Request-Method": "GET",
    },
  });
  // Preflight works because HttpMiddleware.cors() short-circuits and
  // builds the response itself.
  expect(res.status).toBe(204);
  expect(res.headers.get("access-control-allow-origin")).toBe("*");
});

test("GET response carries Access-Control-Allow-Origin (BUG: missing)", async () => {
  const res = await fetch(`${BASE_URL}/hello`, {
    method: "GET",
    headers: { Origin: ORIGIN },
  });

  expect(res.status).toBe(200);
  const body = (await res.json()) as { message: string };
  expect(body.message).toBe("world");

  // The bug: this assertion FAILS. HttpMiddleware.cors() registered a
  // preResponseHandler on the request, but Cloudflare.Worker's wrapper
  // never drains that queue, so no CORS header is on the actual
  // response — only on preflight.
  expect(res.headers.get("access-control-allow-origin")).toBe("*");
});
