import {
  createServer,
  request as httpRequest,
  type IncomingHttpHeaders,
} from "node:http";
import { connect, BlockList, isIP, type Socket } from "node:net";
import { resolve4 } from "node:dns/promises";

const blocked = new BlockList();
for (const [address, prefix] of [
  ["0.0.0.0", 8],
  ["10.0.0.0", 8],
  ["100.64.0.0", 10],
  ["127.0.0.0", 8],
  ["169.254.0.0", 16],
  ["172.16.0.0", 12],
  ["192.0.0.0", 24],
  ["192.0.2.0", 24],
  ["192.88.99.0", 24],
  ["192.168.0.0", 16],
  ["198.18.0.0", 15],
  ["198.51.100.0", 24],
  ["203.0.113.0", 24],
  ["224.0.0.0", 4],
  ["240.0.0.0", 4],
] as const)
  blocked.addSubnet(address, prefix);
export const publicIPv4 = (ip: string) => isIP(ip) === 4 && !blocked.check(ip);
export function publicTarget(value: string) {
  const url = new URL(value);
  if (
    !["http:", "https:"].includes(url.protocol) ||
    url.username ||
    url.password ||
    url.port ||
    url.hostname.endsWith(".") ||
    isIP(url.hostname) ||
    !/^(?:[a-z0-9](?:[a-z0-9-]*[a-z0-9])?\.)+[a-z]{2,63}$/.test(url.hostname) ||
    /(?:^|\.)(?:localhost|local|internal|test|invalid|example|onion|arpa|home|lan|svc)$/.test(
      url.hostname,
    )
  )
    throw new Error("Public HTTP(S) host required");
  return url;
}
/** Resolve once and connect to the checked numeric IP, not the hostname a second time. */
export async function publicAddress(
  host: string,
  lookup: (host: string) => Promise<string[]> = resolve4,
): Promise<string> {
  publicTarget(`https://${host}`);
  let timer: ReturnType<typeof setTimeout> | undefined;
  try {
    const addresses = await Promise.race([
      lookup(host),
      new Promise<never>((_, reject) => {
        timer = setTimeout(() => reject(new Error("DNS timeout")), 5000);
      }),
    ]);
    if (!addresses.length || addresses.some((ip) => !publicIPv4(ip)))
      throw new Error("Non-public DNS answer");
    return addresses[0];
  } finally {
    clearTimeout(timer);
  }
}
/** Local public-web egress guard. Not an OS sandbox or protection against a compromised browser. */
export async function createPublicProxy() {
  const sockets = new Set<Socket>();
  let origins: ReadonlySet<string> | undefined;
  const allowed = (origin:string) => !origins || origins.has(origin);
  let bytes = 0,
    closed = false,
    pending = 0;
  const meter = (socket: Socket) => {
    sockets.add(socket);
    socket.setTimeout(30_000, () => socket.destroy());
    socket.on("error", () => {});
    socket.on("close", () => sockets.delete(socket));
    socket.on("data", (data: Buffer) => {
      bytes += data.length;
      if (bytes > 64 * 1024 * 1024) {
        closed = true;
        for (const active of sockets) active.destroy();
      }
    });
  };
  const server = createServer(async (req, res) => {
    pending++;
    try {
      if (closed || pending > 32) throw new Error("Proxy closed or busy");
      const url = publicTarget(req.url ?? "");
      if (url.protocol !== "http:") throw new Error("Use CONNECT for TLS");
      if (!allowed(url.origin)) throw new Error("Origin not delegated");
      const ip = await publicAddress(url.hostname);
      if (closed || req.destroyed || !allowed(url.origin)) throw new Error("Cancelled");
      const headers: IncomingHttpHeaders = { ...req.headers, host: url.host };
      delete headers["proxy-authorization"];
      delete headers["proxy-connection"];
      const upstream = httpRequest(
        {
          host: ip,
          family: 4,
          port: 80,
          path: url.pathname + url.search,
          method: req.method,
          headers,
        },
        (reply) => {
          res.writeHead(reply.statusCode ?? 502, reply.headers);
          reply.pipe(res);
        },
      );
      upstream.on("socket", meter);
      upstream.on("error", () => {
        if (!res.headersSent) res.writeHead(502);
        res.end();
      });
      res.on("close", () => upstream.destroy());
      req.pipe(upstream);
    } catch {
      if (!res.headersSent) res.writeHead(403);
      res.end("Public network policy denied this request");
    } finally {
      pending--;
    }
  });
  server.on("connection", meter);
  server.maxConnections = 32;
  server.requestTimeout = 30_000;
  server.headersTimeout = 10_000;
  server.on("connect", async (req, raw, head) => {
    const client = raw as Socket;
    pending++;
    try {
      if (closed || pending > 32 || !/^[a-zA-Z0-9.-]+:443$/.test(req.url ?? ""))
        throw new Error("Invalid tunnel");
      const host = req.url!.slice(0, -4);
      if (!allowed(`https://${host.toLowerCase()}`)) throw new Error("Origin not delegated");
      const ip = await publicAddress(host);
      if (closed || client.destroyed || !allowed(`https://${host.toLowerCase()}`)) throw new Error("Cancelled");
      const upstream = connect({ host: ip, port: 443, family: 4 });
      meter(upstream);
      client.on("close", () => upstream.destroy());
      upstream.on("error", () => client.destroy());
      upstream.once("connect", () => {
        if (closed || client.destroyed || !allowed(`https://${host.toLowerCase()}`)) {
          upstream.destroy();
          return;
        }
        client.write("HTTP/1.1 200 Connection Established\r\n\r\n");
        if (head.length) upstream.write(head);
        client.pipe(upstream);
        upstream.pipe(client);
      });
    } catch {
      client.end("HTTP/1.1 403 Forbidden\r\nConnection: close\r\n\r\n");
    } finally {
      pending--;
    }
  });
  server.on("upgrade", (_req, socket) => socket.destroy());
  await new Promise<void>((resolve, reject) => {
    server.once("error", reject);
    server.listen(0, "127.0.0.1", resolve);
  });
  const port = (server.address() as { port: number }).port;
  return {
    url: `http://127.0.0.1:${port}`,
    /** Switch the existing browser's egress scope; old TLS tunnels cannot retain broader authority. */
    restrictOrigins(next?:readonly string[]) {
      if (next && (next.length>16 || next.some(origin=>publicTarget(origin).origin!==origin))) throw Error("Invalid delegated origins");
      const value=next?new Set(next):undefined;
      if (JSON.stringify(value?[...value].sort():null)===JSON.stringify(origins?[...origins].sort():null)) return;
      origins=value;
      for(const socket of sockets)socket.destroy();
    },
    close: async () => {
      closed = true;
      for (const socket of sockets) socket.destroy();
      await new Promise<void>((resolve) => server.close(() => resolve()));
    },
  };
}
