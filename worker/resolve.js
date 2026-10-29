// A tiny Cloudflare Worker. Its only job: take a Google Maps SHORT link
// (maps.app.goo.gl/...) and answer with the LONG link it points to.
// Why it exists: a browser is not allowed to follow that redirect itself,
// but a server can. The site sends the short link here and gets the long one back.

// only this site may read the answer
const ALLOWED_SITE = "https://iwantfreecode.github.io";

// we only ever visit Google's own map hosts (so nobody can use this to fetch random sites)
const ALLOWED_HOSTS = ["maps.app.goo.gl", "goo.gl", "maps.google.com", "www.google.com", "google.com"];

const reply = (body, status = 200) =>
  new Response(JSON.stringify(body), {
    status,
    headers: {
      "Content-Type": "application/json",
      "Access-Control-Allow-Origin": ALLOWED_SITE,
    },
  });

export default {
  async fetch(request) {
    const target = new URL(request.url).searchParams.get("url");
    if (!target) return reply({ error: "no link given" }, 400);

    let current;
    try {
      current = new URL(target);
    } catch {
      return reply({ error: "that is not a link" }, 400);
    }

    // follow the redirects ourselves, one hop at a time, checking every hop
    for (let hop = 0; hop < 6; hop++) {
      if (current.protocol !== "https:" || !ALLOWED_HOSTS.includes(current.hostname)) {
        return reply({ error: "that link is not a google maps link" }, 400);
      }

      const res = await fetch(current.toString(), {
        redirect: "manual",
        headers: { "User-Agent": "Mozilla/5.0", "Accept-Language": "en" },
      });

      const next = res.headers.get("Location");
      if (res.status < 300 || res.status >= 400 || !next) {
        return reply({ url: current.toString() }); // no more redirects: this is the long link
      }

      const nextUrl = new URL(next, current);

      // sometimes Google sends a "cookie consent" page first. the real link is inside it.
      if (nextUrl.hostname === "consent.google.com" && nextUrl.searchParams.get("continue")) {
        current = new URL(nextUrl.searchParams.get("continue"));
      } else {
        current = nextUrl;
      }
    }
    return reply({ error: "too many redirects" }, 400);
  },
};
