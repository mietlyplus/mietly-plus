import { NextRequest, NextResponse } from "next/server";

// Preview-only server-side proxy to the preview backend.
//
// A preview backend sits behind Vercel Deployment Protection, which a browser on
// the preview frontend cannot satisfy cross-origin. This route lets the browser
// call its own origin instead; the request is forwarded server-side with the
// automation-bypass header, so the secret never reaches the client.
//
// It is inert unless BOTH variables below exist, and they are set only for
// Preview deployments. In production they are absent, so every request here
// returns 404 and the production frontend keeps calling its backend directly.

export const dynamic = "force-dynamic";
// Draft creation fetches a page and calls an AI model, so it can take a while.
export const maxDuration = 60;

// Only what the API needs. Cookies and everything else stay on this side.
const FORWARDED_REQUEST_HEADERS = ["authorization", "content-type", "accept", "accept-language"];

type RouteContext = { params: Promise<{ path: string[] }> };

async function proxy(request: NextRequest, context: RouteContext) {
  const target = String(process.env.PREVIEW_BACKEND_PROXY_URL || "").trim();
  const bypassSecret = String(process.env.PREVIEW_BACKEND_BYPASS_SECRET || "").trim();

  if (!target || !bypassSecret) {
    return NextResponse.json({ message: "Not found." }, { status: 404 });
  }

  const { path } = await context.params;
  // The destination host is fixed by the environment; only the path varies, and
  // each segment is encoded so it cannot escape the /api prefix.
  const url = new URL(`/api/${path.map(encodeURIComponent).join("/")}`, target);
  url.search = request.nextUrl.search;

  const headers = new Headers();
  for (const name of FORWARDED_REQUEST_HEADERS) {
    const value = request.headers.get(name);
    if (value) headers.set(name, value);
  }
  headers.set("x-vercel-protection-bypass", bypassSecret);

  const init: RequestInit = { method: request.method, headers, redirect: "manual", cache: "no-store" };
  if (request.method !== "GET" && request.method !== "HEAD") {
    init.body = await request.arrayBuffer();
  }

  let upstream: Response;
  try {
    upstream = await fetch(url, init);
  } catch {
    return NextResponse.json({ message: "The preview backend could not be reached." }, { status: 502 });
  }

  const responseHeaders = new Headers();
  const contentType = upstream.headers.get("content-type");
  if (contentType) responseHeaders.set("content-type", contentType);
  responseHeaders.set("cache-control", "no-store");

  return new NextResponse(upstream.body, { status: upstream.status, headers: responseHeaders });
}

export {
  proxy as GET,
  proxy as POST,
  proxy as PUT,
  proxy as PATCH,
  proxy as DELETE,
  proxy as OPTIONS,
};
