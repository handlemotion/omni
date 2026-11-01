// A real TCP relay between the service and GreenMail, for network faults GreenMail cannot make
// by itself: drop every connection, refuse new ones, or go silent without closing (a NAT that
// forgot the flow). Bytes pass through untouched; nothing about IMAP is simulated.
import { createServer, type Server, type Socket, connect } from "node:net";
import type { AddressInfo } from "node:net";

interface Pair {
  client: Socket;
  upstream: Socket;
  silent: boolean;
}

export interface FaultyLink {
  port: number;
  /** Connections accepted so far, including refused ones. */
  readonly accepted: number;
  /** Close every open connection (RST), as a server restart or a network drop would. */
  sever(): void;
  /** Accept and immediately close new connections until `restore()`. */
  refuse(): void;
  /** Stop forwarding on open connections without closing them; new connections still work. */
  goSilent(): void;
  restore(): void;
  close(): Promise<void>;
}

export async function faultyLink(target: { host: string; port: number }): Promise<FaultyLink> {
  const pairs = new Set<Pair>();
  let refusing = false;
  let accepted = 0;

  const server: Server = createServer((client) => {
    accepted++;
    if (refusing) {
      client.resetAndDestroy();
      return;
    }
    const upstream = connect(target.port, target.host);
    const pair: Pair = { client, upstream, silent: false };
    pairs.add(pair);
    const drop = () => {
      pairs.delete(pair);
      client.destroy();
      upstream.destroy();
    };
    client.on("data", (chunk) => pair.silent || upstream.write(chunk));
    upstream.on("data", (chunk) => pair.silent || client.write(chunk));
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
    pairs.clear();
  }

  return {
    port: (server.address() as AddressInfo).port,
    get accepted() {
      return accepted;
    },
    sever,
    refuse() {
      refusing = true;
    },
    goSilent() {
      for (const pair of pairs) pair.silent = true;
    },
    restore() {
      refusing = false;
    },
    async close() {
      sever();
      await new Promise((resolve) => server.close(resolve));
    },
  };
}
