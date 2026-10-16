import Bonjour from "bonjour-service";
import type { EventEmitter } from "node:events";

export function createDiscovery(address: string, onError: () => void) {
  const bonjour = new Bonjour(
    // Bind the reusable mDNS port to wildcard, while membership and outgoing
    // multicast stay on the explicitly selected interface. Binding that port
    // to a unicast address conflicts with macOS's existing mDNS listener.
    { interface: address, bind: "0.0.0.0" } as ConstructorParameters<
      typeof Bonjour
    >[0],
    onError,
  );
  // The pinned bonjour-service forwards response errors to its callback, but
  // not multicast-dns EventEmitter errors (including async bind failures).
  // Keep this dependency boundary here and cover it with a regression test.
  const mdns = (bonjour as unknown as { server: { mdns: EventEmitter } }).server
    .mdns;
  mdns.on("error", onError);
  return bonjour;
}
