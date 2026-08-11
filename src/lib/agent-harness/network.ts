import { isIP } from "node:net";

export function isPrivateOrLocalHost(value: string) {
  const host = value.toLowerCase().replace(/^\[|\]$/g, "").replace(/\.+$/, "");
  if (host === "localhost" || host.endsWith(".localhost") || host === "localhost.localdomain") return true;
  if (isIP(host) === 4) {
    const [a, b] = host.split(".").map(Number);
    return a === 0 || a === 10 || a === 127 || a >= 224 ||
      (a === 100 && b >= 64 && b <= 127) ||
      (a === 169 && b === 254) ||
      (a === 172 && b >= 16 && b <= 31) ||
      (a === 192 && b === 168) ||
      (a === 198 && (b === 18 || b === 19));
  }
  if (isIP(host) === 6) {
    if (host === "::" || host === "::1" || host.startsWith("fc") || host.startsWith("fd") ||
        /^fe[89ab]/.test(host) || host.startsWith("ff")) return true;
    const mapped = /^(?:::ffff:)(\d+\.\d+\.\d+\.\d+)$/.exec(host)?.[1];
    if (mapped) return isPrivateOrLocalHost(mapped);
    const mappedHex = /^::ffff:([0-9a-f]{1,4}):([0-9a-f]{1,4})$/.exec(host);
    if (mappedHex) {
      const high = Number.parseInt(mappedHex[1], 16);
      const low = Number.parseInt(mappedHex[2], 16);
      return isPrivateOrLocalHost(`${high >> 8}.${high & 255}.${low >> 8}.${low & 255}`);
    }
    return false;
  }
  return false;
}
