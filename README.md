# alchemy-effect — `HttpMiddleware.cors()` doesn't tag actual responses on Cloudflare Worker

Reproduction of a CORS bug that surfaces when serving an `HttpApi` from a
`Cloudflare.Worker` resource using effect's built-in
`HttpMiddleware.cors()`.

## Versions

- `alchemy@2.0.0-beta.29`
- `effect@4.0.0-beta.58`

## Symptom

`HttpMiddleware.cors()` is wrapped around the API handler. From a browser
the network call fails with:

```
Access to fetch at '<worker>/hello' from origin '<page>'
  has been blocked by CORS policy:
  No 'Access-Control-Allow-Origin' header is present on the requested
  resource.
```

The browser's preflight (`OPTIONS`) request succeeds and carries the
expected `Access-Control-Allow-Origin: *` header. The actual `GET`
response is missing every CORS header.

```sh
# preflight works
curl -i -X OPTIONS \
  -H "Origin: https://example.test" \
  -H "Access-Control-Request-Method: GET" \
  $WORKER_URL/hello | grep -i access-control
# → access-control-allow-origin: *
# → access-control-allow-methods: GET, HEAD, PUT, PATCH, POST, DELETE

# actual response has no CORS headers
curl -i -H "Origin: https://example.test" $WORKER_URL/hello | grep -i access-control
# → (no output)
```

## Root cause

`HttpMiddleware.cors()` handles the two paths differently:

```ts
// simplified from effect's source
return httpApp => Effect.withFiber(fiber => {
  const request = ...;
  if (request.method === "OPTIONS") {
    // Short-circuit: build a 204 response with all the CORS headers here.
    return Effect.succeed(Response.empty({ status: 204, headers: ... }));
  }
  // For non-preflight requests: register a callback on the request that
  // a downstream pre-response stage is supposed to invoke before sending.
  appendPreResponseHandlerUnsafe(request, preResponseHandler);
  return httpApp;
});
```

- **OPTIONS preflight** — cors builds the response itself with headers,
  and that response goes back unchanged. ✅
- **GET / POST / etc.** — cors does NOT touch the response. It pushes a
  `preResponseHandler` onto a list on the request. The list is meant to
  be drained by the platform layer right before the response is sent;
  that's the part that adds `Access-Control-Allow-Origin` to actual
  responses.

When running an effect HTTP server (e.g. `BunHttpServer.layer`) the
server loop walks that pre-response queue. The `Cloudflare.Worker`
wrapper takes the `Effect<HttpServerResponse>` you returned and converts
it directly to a Cloudflare `Response` — the pre-response queue is never
drained, so CORS headers never make it onto real responses.

## Reproduction

```sh
bun install

# Auth happens on first deploy. Pass --profile if you have a saved one.
bun run deploy
# → prints { url: "https://...workers.dev" }
```

Drop the URL into a `.env` file (bun auto-loads it on `bun test`):

```ini
WORKER_URL=https://your-deployed-url.workers.dev
```

Then:

```sh
bun test
# → 1 pass, 1 fail (the failing one is the bug)

# Tear it down when done.
bun run destroy
```

[`test/cors.test.ts`](test/cors.test.ts) is the executable spec:

- ✅ `OPTIONS preflight carries Access-Control-Allow-Origin` — passes
- ❌ `GET response carries Access-Control-Allow-Origin` — fails

## Workaround

Stamp CORS headers manually on responses, since the effect middleware's
non-preflight branch can't fire its hook in this setup:

```ts
const CORS = {
  "access-control-allow-origin": "*",
  "access-control-allow-methods": "GET, HEAD, PUT, PATCH, POST, DELETE, OPTIONS",
  "access-control-allow-headers": "*",
  "access-control-max-age": "86400",
};

return Effect.gen(function* () {
  const request = yield* HttpServerRequest.HttpServerRequest;
  if (request.method === "OPTIONS") {
    return HttpServerResponse.empty({ status: 204, headers: CORS });
  }
  const response = yield* apiHandler;
  return HttpServerResponse.setHeaders(response, CORS);
});
```

This works but loses the per-origin / credentials logic baked into
`HttpMiddleware.cors()` (allowedOrigins, conditional Vary, etc.).

## Suggested fix

Either of:

1. Drain the request's pre-response handler queue inside
   `Cloudflare.Worker`'s response converter (probably the right place;
   keeps the existing effect HTTP middleware contract intact).
2. Document that pre-response handlers don't fire under
   `Cloudflare.Worker` and steer users toward a different CORS pattern
   for that environment.

## Note: a separate `Test.make` issue I hit while building this repro

I originally wrote the test using `alchemy/Test/Bun`'s
`Test.make({ providers: Cloudflare.providers(), state: Cloudflare.state() })`
plus `beforeAll(deploy(Stack))`, mirroring
[`examples/cloudflare-worker-async/test/integ.test.ts`](https://github.com/alchemy-run/alchemy-effect/blob/main/examples/cloudflare-worker-async/test/integ.test.ts).
That fails immediately with:

```
error: Service not found: AuthProviders
  (defined at .../alchemy/src/Auth/AuthProvider.ts:25:44)
```

…even when `ALCHEMY_PROFILE` is set and the profile exists. The same
example test inside the alchemy repo itself fails identically when
invoked via `bun test`. The repo's `package.json` runs the suite via
`bun vitest run` (`scripts/test.ts`), not `bun:test`, so the bun adapter
path may have regressed. That's why the test in this repro hits the
deployed URL directly via `fetch` instead of going through `Test.make`.

If you'd rather I split that into its own minimal reproduction, happy
to.

## Layout

```
.
├── alchemy.run.ts          # Stack definition
├── src/
│   └── api.ts              # HttpApi + Worker, with HttpMiddleware.cors()
├── test/
│   └── cors.test.ts        # bun:test assertions against deployed URL
├── package.json
├── tsconfig.json
├── bunfig.toml             # linker = "hoisted" (single effect install)
└── README.md
```
