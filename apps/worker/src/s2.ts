import type { Config } from "./env.ts";

export interface S2Record {
  seqNum: number;
  body: string;
}

export class S2Error extends Error {
  readonly status: number;
  readonly code: string | undefined;
  constructor(status: number, code: string | undefined, message: string) {
    super(message);
    this.name = "S2Error";
    this.status = status;
    this.code = code;
  }
}

/** The configured basin, or null when live co-editing is off. */
export function s2Basin(config: Config) {
  if (!config.S2_BASIN_URL || !config.S2_BASIN) return null;
  const base = config.S2_BASIN_URL.replace(/\/+$/, "");
  const headers = {
    "s2-basin": config.S2_BASIN,
    "s2-format": "raw",
    authorization: `Bearer ${config.S2_ACCESS_TOKEN ?? "local"}`,
  };
  const records = (stream: string) => `${base}/streams/${encodeURIComponent(stream)}/records`;
  const call = async <T>(url: string, init: RequestInit = {}) => {
    const response = await fetch(url, { ...init, headers: { ...headers, ...init.headers } });
    const body = (await response.json().catch(() => null)) as Record<string, unknown> | null;
    if (!response.ok) {
      const code = typeof body?.code === "string" ? body.code : undefined;
      throw new S2Error(response.status, code, `S2 answered ${response.status} ${code ?? ""}`);
    }
    return body as T;
  };
  return {
    async append(stream: string, body: string, matchSeqNum?: number) {
      try {
        const done = await call<{ start: { seq_num: number } }>(records(stream), {
          method: "POST",
          headers: { "content-type": "application/json" },
          body: JSON.stringify({
            records: [{ body }],
            ...(matchSeqNum === undefined ? {} : { match_seq_num: matchSeqNum }),
          }),
        });
        return done.start.seq_num;
      } catch (error) {
        if (matchSeqNum !== undefined && error instanceof S2Error && error.status === 412) {
          return null;
        }
        throw error;
      }
    },
    async read(stream: string, from: number, count = 1000) {
      try {
        const { records: batch } = await call<{ records: { seq_num: number; body?: string }[] }>(
          `${records(stream)}?seq_num=${from}&count=${count}`,
        );
        return {
          records: batch.map((r) => ({ seqNum: r.seq_num, body: r.body ?? "" }) satisfies S2Record),
          more: batch.length === count,
        };
      } catch (error) {
        if (error instanceof S2Error && error.status === 416) return { records: [], more: false };
        throw error;
      }
    },
  };
}

export type S2Basin = NonNullable<ReturnType<typeof s2Basin>>;
