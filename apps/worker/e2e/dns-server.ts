import dgram from "node:dgram";
import packet, { type Answer } from "dns-packet";

type RecordType = "TXT" | "MX" | "CNAME" | "A";
type Value = string | { priority: number; exchange: string };

export interface DnsServer {
  /** `ip:port`, for the mail service's DNS_RESOLVERS. */
  address: string;
  port: number;
  /** Starts answering for `zone` and everything under it. */
  addZone(zone: string): void;
  /** Replaces the records of one type at a name. An empty list removes them. */
  set(name: string, type: RecordType, values: Value[]): void;
  /** Every query received, in order: for asserting the nameservers were asked. */
  queries: { name: string; type: string }[];
  close(): Promise<void>;
}

export const startDnsServer: () => Promise<DnsServer> = async () => {
  const zones = new Set<string>();
  const records = new Map<string, Map<RecordType, Value[]>>();
  const queries: { name: string; type: string }[] = [];
  const key = (name: string) => name.toLowerCase().replace(/\.$/, "");
  const zoneOf = (name: string) =>
    [...zones].find((zone) => name === zone || name.endsWith(`.${zone}`)) ?? null;
  const exists = (name: string) =>
    zones.has(name) ||
    name === `ns1.${zoneOf(name)}` ||
    [...records.keys()].some((n) => n === name || n.endsWith(`.${name}`));

  const answer: (name: string, type: string) => { rcode: number; answers: Answer[] } = (
    name,
    type,
  ) => {
    const zone = zoneOf(name);
    if (!zone) return { rcode: 5, answers: [] };
    if (!exists(name)) return { rcode: 3, answers: [] };
    const at = records.get(name);
    const cname = at?.get("CNAME");
    if (cname && type !== "CNAME") {
      return { rcode: 0, answers: [{ type: "CNAME", name, ttl: 300, data: String(cname[0]) }] };
    }
    if (type === "NS" && zones.has(name)) {
      return { rcode: 0, answers: [{ type: "NS", name, ttl: 86_400, data: `ns1.${name}` }] };
    }
    if (type === "A" && name === `ns1.${zone}`) {
      return { rcode: 0, answers: [{ type: "A", name, ttl: 86_400, data: "127.0.0.1" }] };
    }
    const values = at?.get(type as RecordType) ?? [];
    return {
      rcode: 0,
      answers: values.map<Answer>((value) => {
        if (type === "MX") {
          const mx = value as { priority: number; exchange: string };
          return {
            type: "MX",
            name,
            ttl: 300,
            data: { preference: mx.priority, exchange: mx.exchange },
          };
        }
        if (type === "TXT") return { type: "TXT", name, ttl: 300, data: value as string };
        return { type: type as "CNAME" | "A", name, ttl: 300, data: value as string };
      }),
    };
  };

  const socket = dgram.createSocket("udp4");
  socket.on("message", (message, peer) => {
    let query: ReturnType<typeof packet.decode>;
    try {
      query = packet.decode(message);
    } catch {
      return;
    }
    const question = query.questions?.[0];
    if (!question) return;
    const name = key(question.name);
    queries.push({ name, type: question.type });
    const { rcode, answers } = answer(name, question.type);
    const response = packet.encode({
      id: query.id,
      type: "response",
      flags: packet.AUTHORITATIVE_ANSWER | rcode,
      questions: query.questions,
      answers,
    });
    socket.send(response, peer.port, peer.address);
  });
  await new Promise<void>((resolve) => socket.bind(0, "127.0.0.1", resolve));
  const { port } = socket.address();

  return {
    address: `127.0.0.1:${port}`,
    port,
    queries,
    addZone: (zone) => zones.add(key(zone)),
    set(name, type, values) {
      const at = records.get(key(name)) ?? new Map<RecordType, Value[]>();
      if (values.length === 0) at.delete(type);
      else at.set(type, values);
      if (at.size === 0) records.delete(key(name));
      else records.set(key(name), at);
    },
    close: () => new Promise<void>((resolve) => socket.close(() => resolve())),
  };
};
