import assert from "node:assert/strict";
import { build } from "esbuild";
import * as runtime from "miniflare";

// Exercise native fetch in workerd: Node mocks do not enforce its receiver or redirect modes.
const bundle = await build({
  stdin: {
    contents: `import { CloudflareSetup } from './packages/api/src/services/setup-cloudflare.ts';
      export default { async fetch(request) {
        try {
          const redirect = new URL(request.url).pathname === '/redirect';
          const result = await new CloudflareSetup('runtime-test-only').get('/zones?redirect=' + redirect);
          return Response.json(result);
        } catch (e) { return new Response(e.message, {status: 502}); }
      }};`,
    resolveDir: process.cwd(),
  },
  bundle: true,
  write: false,
  format: "esm",
  platform: "browser",
});
let calls = 0;
const options = {
  modules: true,
  compatibilityDate: "2025-01-01",
  compatibilityFlags: ["global_fetch_strictly_public"],
  script: bundle.outputFiles[0].text,
  outboundService(request) {
    calls++;
    const url = new URL(request.url);
    assert.equal(url.origin, "https://api.cloudflare.com");
    assert.equal(
      request.headers.get("Authorization"),
      "Bearer runtime-test-only",
    );
    return url.searchParams.get("redirect") === "true"
      ? new Response(null, {
          status: 302,
          headers: { Location: "https://other.example/" },
        })
      : Response.json({ success: true, result: [{ id: "runtime-zone" }] });
  },
};
const mf = new runtime.Miniflare(
  runtime.convertV4MiniflareOptions
    ? runtime.convertV4MiniflareOptions(options)
    : options,
);
try {
  const response = await mf.dispatchFetch("http://localhost/");
  assert.equal(response.status, 200, await response.clone().text());
  assert.deepEqual(await response.json(), [{ id: "runtime-zone" }]);
  assert.equal(calls, 1);
  const redirect = await mf.dispatchFetch("http://localhost/redirect");
  assert.equal(redirect.status, 502);
  assert.match(await redirect.text(), /could not complete/);
  assert.equal(calls, 2, "must not follow redirects");
  console.log(
    "Workers runtime setup checks passed: native fetch and redirect rejection.",
  );
} finally {
  await mf.dispose();
}
