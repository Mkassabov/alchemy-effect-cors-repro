import * as Cloudflare from "alchemy/Cloudflare";
import * as Test from "alchemy/Test/Bun";
import { expect } from "bun:test";
import * as Effect from "effect/Effect";
import Stack from "../alchemy.run.ts";

const { test, beforeAll, afterAll, deploy, destroy } = Test.make({
  providers: Cloudflare.providers(),
  state: Cloudflare.state(),
});

const stack = beforeAll(deploy(Stack));
afterAll.skipIf(!!process.env.NO_DESTROY)(destroy(Stack));

const ORIGIN = "https://example.test";

test(
  "OPTIONS preflight carries Access-Control-Allow-Origin",
  Effect.gen(function* () {
    const out = yield* stack;
    const url = `${out.url}/hello`;
    const res = yield* Effect.tryPromise(() =>
      fetch(url, {
        method: "OPTIONS",
        headers: {
          Origin: ORIGIN,
          "Access-Control-Request-Method": "GET",
        },
      }),
    );
    // Preflight works because HttpMiddleware.cors() short-circuits and
    // builds the response itself.
    expect(res.headers.get("access-control-allow-origin")).toBe("*");
  }),
);

test(
  "GET response carries Access-Control-Allow-Origin (BUG: missing)",
  Effect.gen(function* () {
    const out = yield* stack;
    const url = `${out.url}/hello`;
    const res = yield* Effect.tryPromise(() =>
      fetch(url, { method: "GET", headers: { Origin: ORIGIN } }),
    );
    // Body should still be the typed payload.
    const body = (yield* Effect.tryPromise(() => res.json())) as {
      message: string;
    };
    expect(body.message).toBe("world");

    // The bug: this assertion FAILS. HttpMiddleware.cors() registered a
    // preResponseHandler on the request, but Cloudflare.Worker's wrapper
    // never drains that queue, so no CORS header is on the actual
    // response — only on preflight.
    expect(res.headers.get("access-control-allow-origin")).toBe("*");
  }),
);
