import * as Cloudflare from "alchemy/Cloudflare";
import * as Effect from "effect/Effect";
import * as Layer from "effect/Layer";
import * as Path from "effect/Path";
import * as Schema from "effect/Schema";
import * as Etag from "effect/unstable/http/Etag";
import * as HttpMiddleware from "effect/unstable/http/HttpMiddleware";
import * as HttpPlatform from "effect/unstable/http/HttpPlatform";
import * as HttpRouter from "effect/unstable/http/HttpRouter";
import * as HttpApi from "effect/unstable/httpapi/HttpApi";
import * as HttpApiBuilder from "effect/unstable/httpapi/HttpApiBuilder";
import * as HttpApiEndpoint from "effect/unstable/httpapi/HttpApiEndpoint";
import * as HttpApiGroup from "effect/unstable/httpapi/HttpApiGroup";

const Hello = Schema.Struct({ message: Schema.String });

const helloEndpoint = HttpApiEndpoint.get("hello", "/hello", {
  success: Hello,
});

class HelloGroup extends HttpApiGroup.make("hello").add(helloEndpoint) {}

class TestApi extends HttpApi.make("test-api").add(HelloGroup) {}

// HttpPlatform doesn't issue file responses here; stub it out so we don't
// pull a FileSystem dependency that workers don't ship.
const HttpPlatformStub = Layer.succeed(HttpPlatform.HttpPlatform, {
  fileResponse: () => Effect.die("HttpPlatform.fileResponse not supported"),
  fileWebResponse: () =>
    Effect.die("HttpPlatform.fileWebResponse not supported"),
});

export default Cloudflare.Worker(
  "Worker",
  {
    main: import.meta.path,
    compatibility: { flags: ["nodejs_compat"], date: "2026-04-02" },
  },
  Effect.gen(function* () {
    const helloGroup = HttpApiBuilder.group(TestApi, "hello", (handlers) =>
      handlers.handle("hello", () => Effect.succeed({ message: "world" })),
    );

    return {
      fetch: Effect.gen(function* () {
        const apiHandler = yield* HttpApiBuilder.layer(TestApi).pipe(
          Layer.provide(helloGroup),
          Layer.provide([Etag.layer, HttpPlatformStub, Path.layer]),
          HttpRouter.toHttpEffect,
        );

        // The thing under test: HttpMiddleware.cors() should add CORS
        // headers to BOTH preflight (OPTIONS) and actual responses (GET).
        return HttpMiddleware.cors()(apiHandler);
      }),
    };
  }),
);
