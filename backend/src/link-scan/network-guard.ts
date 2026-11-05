/**
 * ─── Where a link scan may send a request ────────────────────────────
 *
 * A link scan requests addresses it found IN WEB PAGES — and a page is whatever its author wrote. Left
 * unchecked, a link to http://169.254.169.254/ or http://localhost:5000/api/… would make this server
 * request its own network on a stranger's behalf: cloud metadata, internal services, the API itself. So
 * nothing is requested unless it is an ordinary public website:
 *
 *   · http or https, on port 80 or 443, with no username or password in the address;
 *   · a host name with a dot in it that is not a local one (localhost, .local, .internal, .lan …), or a
 *     public IP address — IPv4 and IPv6 ranges for loopback, private, link-local, shared, documentation,
 *     multicast and reserved space are all refused, including an IPv4 address wearing IPv6 clothes;
 *   · on Node, a host name that RESOLVES only to public addresses (a public name can point at a private one).
 *
 * This is checked for every address AND for every redirect it is sent on to, because a public page can
 * redirect to a private one. The check cannot stop a name that resolves differently a moment later (DNS
 * rebinding); on Cloudflare, where Workers cannot reach private networks at all, that does not matter, and
 * on Node it is a risk the scan accepts, as every link checker does.
 */

export type GuardVerdict = { ok: true } | { ok: false; why: string };

const LOCAL_SUFFIXES = ['.localhost', '.local', '.internal', '.lan', '.home.arpa', '.intranet', '.corp', '.private'];

function ipv4Parts(host: string): number[] | null {
  const match = /^(\d{1,3})\.(\d{1,3})\.(\d{1,3})\.(\d{1,3})$/.exec(host);
  if (!match) return null;
  const parts = match.slice(1).map(Number);
  return parts.every((part) => part >= 0 && part <= 255) ? parts : null;
}

/** True when an IPv4 address is in space that is not on the public internet. */
export function ipv4IsPrivate(parts: number[]): boolean {
  const [a, b, c] = parts as [number, number, number, number];
  return (
    a === 0
    || a === 10
    || a === 127
    || (a === 100 && b >= 64 && b <= 127) // shared address space (carrier-grade NAT)
    || (a === 169 && b === 254) // link-local, including cloud metadata
    || (a === 172 && b >= 16 && b <= 31)
    || (a === 192 && b === 0 && (c === 0 || c === 2)) // protocol assignments, documentation
    || (a === 192 && b === 88 && c === 99)
    || (a === 192 && b === 168)
    || (a === 198 && (b === 18 || b === 19)) // benchmarking
    || (a === 198 && b === 51 && c === 100)
    || (a === 203 && b === 0 && c === 113)
    || a >= 224 // multicast and reserved, including the broadcast address
  );
}

/** Expands `::` and returns the eight 16-bit groups of an IPv6 address, or null when it is not one. */
function ipv6Groups(host: string): number[] | null {
  if (!/^[0-9a-f:.]+$/i.test(host) || !host.includes(':')) return null;
  let text = host;
  // A dotted IPv4 tail (::ffff:1.2.3.4) counts as the last two groups.
  const tail = /(\d{1,3}(?:\.\d{1,3}){3})$/.exec(text);
  if (tail) {
    const v4 = ipv4Parts(tail[1]!);
    if (!v4) return null;
    text = `${text.slice(0, -tail[1]!.length)}${((v4[0]! << 8) | v4[1]!).toString(16)}:${((v4[2]! << 8) | v4[3]!).toString(16)}`;
  }
  const halves = text.split('::');
  if (halves.length > 2) return null;
  const head = halves[0] ? halves[0].split(':') : [];
  const rest = halves.length === 2 && halves[1] ? halves[1].split(':') : [];
  const missing = 8 - head.length - rest.length;
  if (halves.length === 1 ? missing !== 0 : missing < 1) return null;
  const groups = [...head, ...Array(halves.length === 2 ? missing : 0).fill('0'), ...rest].map((group) => parseInt(group, 16));
  return groups.length === 8 && groups.every((group) => Number.isInteger(group) && group >= 0 && group <= 0xffff) ? groups : null;
}

/** True when an IPv6 address is loopback, private, link-local, multicast, documentation or otherwise not public. */
export function ipv6IsPrivate(groups: number[]): boolean {
  const [g0, g1, g2, g3, g4, g5, g6, g7] = groups as [number, number, number, number, number, number, number, number];
  const unspecifiedOrLoopback = g0 === 0 && g1 === 0 && g2 === 0 && g3 === 0 && g4 === 0 && g5 === 0 && g6 === 0 && (g7 === 0 || g7 === 1);
  if (unspecifiedOrLoopback) return true;
  // IPv4-mapped (::ffff:a.b.c.d) and the deprecated IPv4-compatible form: the IPv4 address decides.
  if (g0 === 0 && g1 === 0 && g2 === 0 && g3 === 0 && g4 === 0 && (g5 === 0xffff || g5 === 0)) {
    return ipv4IsPrivate([g6 >> 8, g6 & 255, g7 >> 8, g7 & 255]);
  }
  return (
    (g0 & 0xfe00) === 0xfc00 // unique local fc00::/7
    || (g0 & 0xffc0) === 0xfe80 // link-local fe80::/10
    || (g0 & 0xffc0) === 0xfec0 // site-local (deprecated)
    || (g0 & 0xff00) === 0xff00 // multicast
    || (g0 === 0x2001 && g1 === 0x0db8) // documentation
    || g0 === 0x2002 // 6to4, which embeds an IPv4 address
    || (g0 === 0x0064 && g1 === 0xff9b) // NAT64
  );
}

/** Verdict on an address from its text alone — no network. */
export function checkAddress(raw: string, options: { allowPrivateNetwork?: boolean } = {}): GuardVerdict {
  let url: URL;
  try {
    url = new URL(raw);
  } catch {
    return { ok: false, why: 'not a valid address' };
  }
  if (url.protocol !== 'http:' && url.protocol !== 'https:') return { ok: false, why: 'not a web address' };
  if (raw.length > 2048) return { ok: false, why: 'the address is too long' };
  if (url.username || url.password) return { ok: false, why: 'the address contains a username or password' };
  if (options.allowPrivateNetwork) return { ok: true };

  if (url.port && url.port !== '80' && url.port !== '443') return { ok: false, why: 'it uses an unusual port' };

  const host = url.hostname.toLowerCase().replace(/^\[|\]$/g, '').replace(/\.$/, '');
  if (!host) return { ok: false, why: 'it has no host' };

  const v4 = ipv4Parts(host);
  if (v4) return ipv4IsPrivate(v4) ? { ok: false, why: 'it points at a private network address' } : { ok: true };
  const v6 = ipv6Groups(host);
  if (v6) return ipv6IsPrivate(v6) ? { ok: false, why: 'it points at a private network address' } : { ok: true };

  if (host === 'localhost' || LOCAL_SUFFIXES.some((suffix) => host.endsWith(suffix))) return { ok: false, why: 'it points at a local address' };
  // Every public host has a dot; a one-word name only means something on a private network.
  if (!host.includes('.')) return { ok: false, why: 'it points at a local address' };
  return { ok: true };
}

const resolved = new Map<string, boolean>();

/**
 * On Node, whether every address a host name resolves to is public. Cached per host for the life of the
 * process. Resolves true where DNS cannot be asked (Cloudflare Workers) and when the lookup itself fails:
 * a name that does not resolve is reported by the request, as "domain not found", not here.
 */
export async function resolvesToPublicAddresses(host: string): Promise<boolean> {
  const name = host.toLowerCase();
  const known = resolved.get(name);
  if (known !== undefined) return known;
  let answer = true;
  try {
    const dns = (process as { getBuiltinModule?: (id: string) => unknown }).getBuiltinModule?.('node:dns') as
      | { promises: { lookup(host: string, options: { all: true }): Promise<Array<{ address: string; family: number }>> } }
      | undefined;
    if (dns && !(typeof navigator !== 'undefined' && navigator.userAgent === 'Cloudflare-Workers')) {
      const addresses = await dns.promises.lookup(name, { all: true });
      answer = addresses.every(({ address, family }) => {
        if (family === 4) {
          const parts = ipv4Parts(address);
          return parts ? !ipv4IsPrivate(parts) : true;
        }
        const groups = ipv6Groups(address.toLowerCase());
        return groups ? !ipv6IsPrivate(groups) : true;
      });
    }
  } catch {
    answer = true;
  }
  if (resolved.size > 5000) resolved.clear();
  resolved.set(name, answer);
  return answer;
}

/** The full verdict for a request about to be made: the address itself, then (on Node) what its host resolves to. */
export async function mayRequest(raw: string, options: { allowPrivateNetwork?: boolean } = {}): Promise<GuardVerdict> {
  const verdict = checkAddress(raw, options);
  if (!verdict.ok || options.allowPrivateNetwork) return verdict;
  const host = new URL(raw).hostname;
  if (ipv4Parts(host) || host.startsWith('[')) return verdict;
  return (await resolvesToPublicAddresses(host)) ? verdict : { ok: false, why: 'its host name points at a private network address' };
}
