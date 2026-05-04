# alchemy-effect — `HttpMiddleware.cors()` doesn't tag actual responses on Cloudflare Worker

Reproduction of a CORS bug surface when serving an `HttpApi` from a
`Cloudflare.Worker` resource using effect's built-in
`HttpMiddleware.cors()`.

## Versions

- `alchemy@2.0.0-beta.29`
- `effect@4.0.0-beta.60`

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
  $WORKER/hello | grep -i access-control
# → access-control-allow-origin: *
# → access-control-allow-methods: GET, HEAD, PUT, PATCH, POST, DELETE

# actual response has no CORS headers
curl -i -H "Origin: https://example.test" $WORKER/hello | grep -i access-control
# → (no output)
```

## Root cause

`HttpMiddleware.cors()` handles the two paths differently
([source](https://github.com/Effect-TS/effect/blob/main/packages/effect/src/unstable/http/HttpMiddleware.ts)):

```ts
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

- **OPTIONS preflight** — cors builds the response itself, with headers,
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

# auth happens on first deploy
bun run deploy
# → prints worker URL

# integration tests (deploys, asserts headers, destroys)
bun test
# expect: "OPTIONS preflight ..." passes, "GET response ..." FAILS.

# tear down when done
bun run destroy
```

The integration test in [`test/integ.test.ts`](test/integ.test.ts) is
the executable spec — preflight assertion passes, GET assertion fails.

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
`HttpMiddleware.cors()`.

## Suggested fix

Either of:

1. Drain the request's pre-response handler queue inside
   `Cloudflare.Worker`'s response converter (probably the right place;
   keeps the existing effect HTTP middleware contract intact).
2. Document that pre-response handlers don't fire under
   `Cloudflare.Worker` and steer users toward a different CORS pattern
   for that environment.

## Layout

```
.
├── alchemy.run.ts          # Stack definition
├── src/
│   └── api.ts              # HttpApi + Worker, with HttpMiddleware.cors()
├── test/
│   └── integ.test.ts       # bun:test integration test using alchemy/Test/Bun
├── package.json
├── tsconfig.json
└── README.md
```
