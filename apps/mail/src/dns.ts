import { promises as dns } from "node:dns";
import type { DnsAnswer, DnsLookupBody, DnsLookupResult, DnsQueryType } from "@omni/contracts";
import type { Logger } from "./log.ts";

export interface DnsOptions {
  /** Recursive resolvers for NS discovery (`ip` or `ip:port`). Empty: the system's. */
  resolvers: string[];
  /** Port the zone's nameservers are asked on: 53, except for a local test server. */
  nameserverPort: number;
  timeoutMs: number;
  logger: Logger;
}

export type DnsLookup = (body: DnsLookupBody) => Promise<DnsLookupResult>;

/** A refusal the route answers with 400. */
export class DnsLookupError extends Error {
  override name = "DnsLookupError";
}

const host = (name: string) => name.toLowerCase().replace(/\.$/, "");

export const createDnsLookup: (options: DnsOptions) => DnsLookup = (options) => {
  const resolver = (servers: string[]) => {
    const r = new dns.Resolver({ timeout: options.timeoutMs, tries: 2 });
    if (servers.length > 0) r.setServers(servers);
    return r;
  };

  const query: (r: dns.Resolver, name: string, type: DnsQueryType) => Promise<DnsAnswer> = async (
    r,
    name,
    type,
  ) => {
    try {
      let values: string[];
      switch (type) {
        case "TXT":
          values = (await r.resolveTxt(name)).map((chunks) => chunks.join(""));
          break;
        case "MX":
          values = (await r.resolveMx(name)).map((mx) => `${mx.priority} ${host(mx.exchange)}`);
          break;
        case "CNAME":
          values = (await r.resolveCname(name)).map(host);
          break;
        case "NS":
          values = (await r.resolveNs(name)).map(host);
          break;
      }
      return values.length > 0 ? { status: "found", values } : { status: "nodata" };
    } catch (error) {
      const code = (error as NodeJS.ErrnoException).code ?? "UNKNOWN";
      if (code === dns.NODATA) return { status: "nodata" };
      if (code === dns.NOTFOUND) return { status: "nxdomain" };
      return { status: "error", code };
    }
  };

  async function findZone(recursive: dns.Resolver, domain: string) {
    const labels = domain.split(".");
    for (let i = 0; i < labels.length - 1; i++) {
      const name = labels.slice(i).join(".");
      const answer = await query(recursive, name, "NS");
      if (answer.status === "found") return { zone: name, nameservers: answer.values };
    }
    return null;
  }

  async function addresses(recursive: dns.Resolver, nameservers: string[]) {
    const found = await Promise.all(
      nameservers.map(async (ns) => {
        const v4 = await recursive.resolve4(ns).catch(() => [] as string[]);
        if (v4.length > 0) return v4;
        return recursive.resolve6(ns).catch(() => [] as string[]);
      }),
    );
    const port = options.nameserverPort;
    return found.flat().map((ip) => (ip.includes(":") ? `[${ip}]:${port}` : `${ip}:${port}`));
  }

  return async ({ domain, queries }) => {
    for (const q of queries) {
      const name = host(q.name);
      if (name !== domain && !name.endsWith(`.${domain}`)) {
        throw new DnsLookupError(`${q.name} is not under ${domain}`);
      }
    }
    const recursive = resolver(options.resolvers);
    const zone = await findZone(recursive, domain);
    const servers = zone ? await addresses(recursive, zone.nameservers) : [];
    const authoritative = servers.length > 0 ? resolver(servers) : null;
    if (!authoritative) {
      options.logger.info("dns.no_authoritative", { domain, zone: zone?.zone ?? null });
    }

    const answers = await Promise.all(
      queries.map(async ({ name, type }) => {
        if (authoritative) {
          const answer = await query(authoritative, name, type);
          if (answer.status !== "error")
            return { name, type, source: "authoritative" as const, answer };
        }
        return {
          name,
          type,
          source: "recursive" as const,
          answer: await query(recursive, name, type),
        };
      }),
    );
    return { zone: zone?.zone ?? null, nameservers: zone?.nameservers ?? [], answers };
  };
};
