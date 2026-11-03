// A real TCP relay between the service and GreenMail, for network faults GreenMail cannot make
// by itself: drop every connection, refuse new ones, go silent without closing (a NAT that
// forgot the flow), or stall new connections (a slow server). Bytes pass through untouched;
// nothing about IMAP or SMTP is simulated.
import { createServer, type Server, type Socket, connect } from "node:net";
import type { AddressInfo } from "node:net";

interface Pair {
  client: Socket;
  upstream: Socket;
  silent: boolean;
  /** Bytes held while the link is stalled, flushed in order by `restore()`. */
  held: { to: Socket; chunk: Buffer }[] | null;
  /** The last bytes the client sent. */
  tail: string;
}

export interface FaultyLink {
  port: number;
  /** Connections accepted so far, including refused ones. */
  readonly accepted: number;
  /** When each connection was accepted (`Date.now()`), including refused ones. */
  readonly acceptedAt: readonly number[];
  /** Connections relayed and still open. */
  readonly open: number;
  /** For each relayed connection that has closed: the last bytes its client sent. */
  readonly closedTails: readonly string[];
  /** Close every open connection (RST), as a server restart or a network drop would. */
  sever(): void;
  /** Accept and immediately close new connections until `restore()`. */
  refuse(): void;
  /** Stop forwarding on open connections without closing them; new connections still work. */
  goSilent(): void;
  /** Hold the bytes of new connections, both ways, until `restore()` delivers them. */
  stall(): void;
  restore(): void;
  close(): Promise<void>;
}

export async function faultyLink(target: { host: string; port: number }): Promise<FaultyLink> {
  const pairs = new Set<Pair>();
  let refusing = false;
  let stalling = false;
  const acceptedAt: number[] = [];
  const closedTails: string[] = [];

  const server: Server = createServer((client) => {
    acceptedAt.push(Date.now());
    if (refusing) {
      client.resetAndDestroy();
      return;
    }
    const upstream = connect(target.port, target.host);
    const pair: Pair = { client, upstream, silent: false, held: stalling ? [] : null, tail: "" };
    pairs.add(pair);
    const drop = () => {
      if (pairs.delete(pair)) closedTails.push(pair.tail);
      client.destroy();
      upstream.destroy();
    };
    const forward = (to: Socket, chunk: Buffer) => {
      if (pair.silent) return;
      if (pair.held) pair.held.push({ to, chunk });
      else to.write(chunk);
    };
    client.on("data", (chunk: Buffer) => {
      pair.tail = (pair.tail + chunk.toString("latin1")).slice(-256);
      forward(upstream, chunk);
    });
    upstream.on("data", (chunk: Buffer) => forward(client, chunk));
    for (const socket of [client, upstream]) {
      socket.on("error", drop);
      socket.on("close", drop);
    }
  });
  await new Promise<void>((resolve) => server.listen(0, "127.0.0.1", resolve));

  function sever() {
    for (const pair of pairs) {
      pair.client.resetAndDestroy();
      pair.upstream.destroy();
    }
  }

  return {
    port: (server.address() as AddressInfo).port,
    get accepted() {
      return acceptedAt.length;
    },
    acceptedAt,
    get open() {
      return pairs.size;
    },
    closedTails,
    sever,
    refuse() {
      refusing = true;
    },
    goSilent() {
      for (const pair of pairs) pair.silent = true;
    },
    stall() {
      stalling = true;
    },
    restore() {
      refusing = false;
      stalling = false;
      for (const pair of pairs) {
        const held = pair.held ?? [];
        pair.held = null;
        for (const { to, chunk } of held) to.write(chunk);
      }
    },
    async close() {
      sever();
      await new Promise((resolve) => server.close(resolve));
    },
  };
}
