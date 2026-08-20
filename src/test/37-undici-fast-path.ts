/**
 * Unit tests for the `undici.request` fast path used when `agentOptions` is
 * set (see `connection.ts`).
 *
 * These tests run against a local stub HTTP server rather than ArangoDB so
 * they can assert on the exact bytes sent and on response shapes the
 * integration suite cannot observe:
 *
 * - Transport parity: the `fetch` path and the `undici` path must emit
 *   identical requests for the same call. This is the regression guard for
 *   header/URL divergences that only affect one transport.
 * - Response shim behaviour: header lookup, lazy header materialization and
 *   `statusText` reconstruction, none of which are visible once a response
 *   has been parsed into a body.
 */
import { expect } from "chai";
import * as http from "node:http";
import { getStatusMessage } from "../connection.js";
import { Database } from "../databases.js";

type CapturedRequest = {
  method: string;
  url: string;
  headers: http.IncomingHttpHeaders;
  body: string;
};

/** Response the stub server should send for the next request. */
type StubResponse = {
  statusCode?: number;
  headers?: Record<string, string | string[]>;
  body?: string;
};

/**
 * A stub HTTP server that records the requests it receives and replies with a
 * configurable response.
 */
class StubServer {
  readonly requests: CapturedRequest[] = [];
  response: StubResponse = {};
  private _server: http.Server;
  private _url = "";

  constructor() {
    this._server = http.createServer((req, res) => {
      const chunks: Buffer[] = [];
      req.on("data", (chunk) => chunks.push(chunk as Buffer));
      req.on("end", () => {
        this.requests.push({
          method: req.method ?? "",
          url: req.url ?? "",
          headers: req.headers,
          body: Buffer.concat(chunks).toString("utf-8"),
        });
        const {
          statusCode = 200,
          headers = { "content-type": "application/json" },
          body = JSON.stringify({ result: true }),
        } = this.response;
        res.writeHead(statusCode, headers);
        // HEAD responses must not include a body.
        res.end(req.method === "HEAD" ? undefined : body);
      });
    });
  }

  get url() {
    return this._url;
  }

  async start() {
    await new Promise<void>((resolve) =>
      this._server.listen(0, "127.0.0.1", resolve),
    );
    const address = this._server.address();
    if (!address || typeof address === "string") {
      throw new Error("Failed to determine stub server address");
    }
    this._url = `http://127.0.0.1:${address.port}`;
  }

  async stop() {
    await new Promise<void>((resolve, reject) =>
      this._server.close((err) => (err ? reject(err) : resolve())),
    );
  }

  reset() {
    this.requests.length = 0;
    this.response = {};
  }
}

/**
 * `agentOptions` is what selects the `undici.request` fast path, so passing it
 * opts a database in to the fast path and omitting it keeps the `fetch` path.
 */
function fastPathDb(url: string, extra: Record<string, any> = {}) {
  return new Database({
    url,
    agentOptions: { keepAliveTimeout: 30000 },
    ...extra,
  });
}

function fetchPathDb(url: string, extra: Record<string, any> = {}) {
  return new Database({ url, ...extra });
}

describe("undici fast path", function () {
  this.timeout(10000);

  const server = new StubServer();

  before(async () => server.start());
  after(async () => server.stop());
  beforeEach(() => server.reset());

  describe("transport parity with fetch", () => {
    /**
     * Issues the same request over both transports and returns what the
     * server saw for each. Any divergence here is a bug in one of the two
     * request-building code paths.
     */
    async function bothTransports(
      run: (db: Database) => Promise<unknown>,
      extra: Record<string, any> = {},
    ): Promise<{ viaFetch: CapturedRequest; viaUndici: CapturedRequest }> {
      const fetchDb = fetchPathDb(server.url, extra);
      try {
        await run(fetchDb);
      } finally {
        fetchDb.close();
      }
      const viaFetch = server.requests.pop()!;

      const undiciDb = fastPathDb(server.url, extra);
      try {
        await run(undiciDb);
      } finally {
        undiciDb.close();
      }
      const viaUndici = server.requests.pop()!;

      expect(viaFetch, "fetch path recorded no request").to.exist;
      expect(viaUndici, "undici path recorded no request").to.exist;
      return { viaFetch, viaUndici };
    }

    it("sends the same method, URL and body for a GET", async () => {
      const { viaFetch, viaUndici } = await bothTransports((db) =>
        db.version(),
      );
      expect(viaUndici.method).to.equal(viaFetch.method);
      expect(viaUndici.url).to.equal(viaFetch.url);
      expect(viaUndici.body).to.equal(viaFetch.body);
    });

    it("sends the same URL when the path has query parameters", async () => {
      const { viaFetch, viaUndici } = await bothTransports((db) =>
        db.request(
          {
            method: "GET",
            pathname: "/_api/version",
            search: { details: "true", other: "a b&c" },
          },
          false,
        ),
      );
      expect(viaUndici.url).to.equal(viaFetch.url);
      // Guard against the query string being dropped entirely on one path.
      expect(viaUndici.url).to.include("details=true");
    });

    it("sends the same body and content-type for a POST", async () => {
      const { viaFetch, viaUndici } = await bothTransports((db) =>
        db.request(
          {
            method: "POST",
            pathname: "/_api/cursor",
            body: { query: "RETURN 1", bindVars: {} },
          },
          false,
        ),
      );
      expect(viaUndici.method).to.equal("POST");
      expect(viaUndici.body).to.equal(viaFetch.body);
      expect(viaUndici.headers["content-type"]).to.equal(
        viaFetch.headers["content-type"],
      );
    });

    it("sends the same default authorization header", async () => {
      const { viaFetch, viaUndici } = await bothTransports((db) =>
        db.version(),
      );
      expect(viaUndici.headers.authorization).to.equal(
        viaFetch.headers.authorization,
      );
    });

    it("preserves a caller-supplied authorization header on both paths", async () => {
      // Regression guard: the fast path rebuilds headers into a plain object,
      // so a differently-cased Authorization header must still suppress the
      // driver's own Basic credentials rather than being overwritten.
      //
      // Note: request headers always reach the transport as a `Headers`
      // instance (config headers go through `new Headers()` and per-request
      // headers through `util.mergeHeaders`), so this exercises the `Headers`
      // branch of the header conversion. The plain-object branch is currently
      // unreachable from the public API and is therefore defensive only.
      const { viaFetch, viaUndici } = await bothTransports(
        (db) => db.version(),
        { fetchOptions: { headers: { Authorization: "Bearer TOKEN-123" } } },
      );
      expect(viaUndici.headers.authorization).to.equal("Bearer TOKEN-123");
      expect(viaUndici.headers.authorization).to.equal(
        viaFetch.headers.authorization,
      );
    });

    it("sends the same custom headers regardless of casing", async () => {
      const { viaFetch, viaUndici } = await bothTransports(
        (db) => db.version(),
        { fetchOptions: { headers: { "X-Custom-Header": "custom-value" } } },
      );
      // Node lowercases incoming header names, so this compares values.
      expect(viaUndici.headers["x-custom-header"]).to.equal("custom-value");
      expect(viaUndici.headers["x-custom-header"]).to.equal(
        viaFetch.headers["x-custom-header"],
      );
    });
  });

  describe("response shim", () => {
    /** Performs a request over the fast path and returns the raw response. */
    async function rawResponse(stub: StubResponse, method = "GET") {
      server.response = stub;
      const db = fastPathDb(server.url);
      try {
        return (await db.request(
          { method, pathname: "/_api/version" },
          false,
        )) as any;
      } finally {
        db.close();
      }
    }

    it("exposes status and ok for a success response", async () => {
      const res = await rawResponse({ statusCode: 200 });
      expect(res.status).to.equal(200);
      expect(res.ok).to.equal(true);
    });

    it("reports ok as false for a 3xx response", async () => {
      // 304 has no body and is not an error status, so it reaches the caller.
      const res = await rawResponse({ statusCode: 304, headers: {} });
      expect(res.status).to.equal(304);
      expect(res.ok).to.equal(false);
    });

    it("looks up headers case-insensitively", async () => {
      const res = await rawResponse({
        headers: {
          "content-type": "application/json",
          "X-Mixed-Case": "mixed",
        },
      });
      expect(res.headers.get("x-mixed-case")).to.equal("mixed");
      expect(res.headers.get("X-MIXED-CASE")).to.equal("mixed");
      expect(res.headers.has("X-Mixed-Case")).to.equal(true);
    });

    it("returns null for a missing header", async () => {
      const res = await rawResponse({});
      expect(res.headers.get("x-does-not-exist")).to.equal(null);
      expect(res.headers.has("x-does-not-exist")).to.equal(false);
    });

    it("joins multi-value headers with a comma", async () => {
      const res = await rawResponse({
        headers: {
          "content-type": "application/json",
          "x-multi": ["one", "two"],
        },
      });
      expect(res.headers.get("x-multi")).to.equal("one, two");
    });

    it("materializes full headers lazily when iterated", async () => {
      const res = await rawResponse({
        headers: {
          "content-type": "application/json",
          "x-first": "1",
          "x-second": "2",
        },
      });
      const entries = new Map<string, string>();
      for (const [key, value] of res.headers as Iterable<[string, string]>) {
        entries.set(key.toLowerCase(), value);
      }
      expect(entries.get("x-first")).to.equal("1");
      expect(entries.get("x-second")).to.equal("2");
      // Lookups must still work after the full Headers object is built.
      expect(res.headers.get("x-first")).to.equal("1");
    });

    it("reconstructs statusText for a known status code", async () => {
      const res = await rawResponse({ statusCode: 404, headers: {} }).catch(
        (e: any) => e.response,
      );
      expect(res.status).to.equal(404);
      // undici.request does not expose the reason phrase, so the shim derives
      // it from the status code to keep getStatusMessage meaningful.
      expect(res.statusText).to.equal("Not Found");
    });

    it("leaves statusText empty for an unrecognized status code", async () => {
      const res = await rawResponse({ statusCode: 509, headers: {} }).catch(
        (e: any) => e.response,
      );
      expect(res.status).to.equal(509);
      expect(res.statusText).to.equal("");
      // getStatusMessage falls back to statusText, then to a generic message.
      expect(getStatusMessage(res)).to.equal("Unknown response status");
    });

    it("keeps getStatusMessage working for known codes", async () => {
      const res = await rawResponse({ statusCode: 404, headers: {} }).catch(
        (e: any) => e.response,
      );
      expect(getStatusMessage(res)).to.equal("Not Found");
    });
  });
});
