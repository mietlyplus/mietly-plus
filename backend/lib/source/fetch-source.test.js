"use strict";

const test = require("node:test");
const assert = require("node:assert/strict");

const { assertPublicUrl, isBlockedAddress, fetchSourceDocument, SourceFetchError } = require("./fetch-source");

async function expectRejection(url, code) {
  await assert.rejects(
    () => assertPublicUrl(url),
    (error) => {
      assert.ok(error instanceof SourceFetchError, `expected SourceFetchError for ${url}`);
      assert.equal(error.code, code, `wrong code for ${url}`);
      return true;
    }
  );
}

test("loopback, private, link-local and metadata addresses are blocked", () => {
  for (const ip of [
    "127.0.0.1", "127.1.2.3", "10.0.0.1", "10.255.255.255",
    "172.16.0.1", "172.31.255.254", "192.168.1.1",
    "169.254.169.254", // cloud metadata
    "100.64.0.1", "0.0.0.0", "224.0.0.1", "240.0.0.1",
    "::1", "::", "fe80::1", "fc00::1", "fd00::1", "ff02::1",
    "::ffff:127.0.0.1", "::ffff:10.0.0.1",
  ]) {
    assert.equal(isBlockedAddress(ip), true, `${ip} must be blocked`);
  }
});

test("ordinary public addresses are allowed", () => {
  for (const ip of ["8.8.8.8", "1.1.1.1", "93.184.216.34", "2606:2800:220:1:248:1893:25c8:1946"]) {
    assert.equal(isBlockedAddress(ip), false, `${ip} must be allowed`);
  }
});

test("non-http protocols are refused", async () => {
  for (const url of ["file:///etc/passwd", "ftp://example.com/x", "gopher://example.com", "data:text/html,hi"]) {
    await expectRejection(url, "UNSUPPORTED_PROTOCOL");
  }
});

test("a malformed URL is refused", async () => {
  for (const url of ["not a url", "", "http://"]) {
    await assert.rejects(() => assertPublicUrl(url));
  }
});

test("credentials embedded in the URL are refused", async () => {
  await expectRejection("https://user:pass@example.com/p", "CREDENTIALS_IN_URL");
});

test("literal private IPs in a URL are refused", async () => {
  await expectRejection("http://127.0.0.1:5000/health", "BLOCKED_ADDRESS");
  await expectRejection("http://169.254.169.254/latest/meta-data/", "BLOCKED_ADDRESS");
  await expectRejection("http://[::1]:8080/", "BLOCKED_ADDRESS");
});

test("localhost-style hostnames are refused without a DNS round trip", async () => {
  await expectRejection("http://localhost:3000/x", "BLOCKED_ADDRESS");
  await expectRejection("http://app.localhost/x", "BLOCKED_ADDRESS");
  await expectRejection("http://service.internal/x", "BLOCKED_ADDRESS");
});

test("a redirect into private space is refused mid-chain", async () => {
  // A literal public IP keeps the test off real DNS.
  const fetchImpl = async (url) => {
    if (url.startsWith("https://93.184.216.34")) {
      return {
        status: 302,
        headers: new Map([["location", "http://169.254.169.254/latest/meta-data/"]]),
        ok: false,
      };
    }
    throw new Error("must not reach the metadata endpoint");
  };

  await assert.rejects(
    () => fetchSourceDocument("https://93.184.216.34/p", { fetchImpl }),
    (error) => error.code === "BLOCKED_ADDRESS"
  );
});

test("a redirect loop is bounded", async () => {
  let hops = 0;
  const fetchImpl = async () => {
    hops += 1;
    return { status: 302, headers: new Map([["location", "https://93.184.216.34/next"]]), ok: false };
  };
  await assert.rejects(
    () => fetchSourceDocument("https://93.184.216.34/start", { fetchImpl }),
    (error) => error.code === "TOO_MANY_REDIRECTS"
  );
  assert.ok(hops <= 5, `redirects must be bounded, saw ${hops}`);
});

test("an oversized declared response is refused", async () => {
  const fetchImpl = async () => ({
    status: 200,
    ok: true,
    headers: new Map([["content-length", String(50 * 1024 * 1024)], ["content-type", "text/html"]]),
    body: null,
  });
  await assert.rejects(
    () => fetchSourceDocument("https://93.184.216.34/p", { fetchImpl }),
    (error) => error.code === "RESPONSE_TOO_LARGE"
  );
});

test("a login wall is reported as access denied, never worked around", async () => {
  for (const status of [401, 403]) {
    const fetchImpl = async () => ({ status, ok: false, headers: new Map(), body: null });
    await assert.rejects(
      () => fetchSourceDocument("https://93.184.216.34/p", { fetchImpl }),
      (error) => error.code === "ACCESS_DENIED"
    );
  }
});

test("a non-HTML response is refused", async () => {
  const fetchImpl = async () => ({
    status: 200, ok: true,
    headers: new Map([["content-type", "application/pdf"]]),
    body: null,
  });
  await assert.rejects(
    () => fetchSourceDocument("https://93.184.216.34/p.pdf", { fetchImpl }),
    (error) => error.code === "UNSUPPORTED_CONTENT_TYPE"
  );
});

test("a normal public page is fetched", async () => {
  const html = "<html><head><title>Hi</title></head><body>ok</body></html>";
  const fetchImpl = async () => ({
    status: 200, ok: true,
    headers: new Map([["content-type", "text/html; charset=utf-8"]]),
    body: {
      getReader() {
        let sent = false;
        return {
          read: async () => (sent ? { done: true } : ((sent = true), { done: false, value: Buffer.from(html) })),
          cancel: async () => {},
        };
      },
    },
  });

  const result = await fetchSourceDocument("https://93.184.216.34/product", { fetchImpl });
  assert.equal(result.html, html);
  assert.equal(result.finalUrl, "https://93.184.216.34/product");
});
