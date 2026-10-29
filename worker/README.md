# link helper (Cloudflare Worker)

Opens Google Maps short links for the food site.

1. Cloudflare dashboard -> Workers & Pages -> Create -> Hello World -> Deploy.
2. Edit code -> delete everything -> paste resolve.js -> Deploy.
3. Copy the worker address (looks like https://something.yourname.workers.dev).
4. Put it in app.js as RESOLVER_URL.
