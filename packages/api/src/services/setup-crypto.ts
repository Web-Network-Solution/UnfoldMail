const encoder = new TextEncoder();
export const encode = (bytes: Uint8Array) =>
  btoa(String.fromCharCode(...bytes))
    .replace(/\+/g, "-")
    .replace(/\//g, "_")
    .replace(/=+$/, "");
const decode = (s: string) =>
  Uint8Array.from(atob(s.replace(/-/g, "+").replace(/_/g, "/")), (c) =>
    c.charCodeAt(0),
  );
export const randomSetupSecret = () =>
  encode(crypto.getRandomValues(new Uint8Array(32)));
export async function setupHash(s: string) {
  return encode(
    new Uint8Array(await crypto.subtle.digest("SHA-256", encoder.encode(s))),
  );
}
async function key(secret: string) {
  if (secret.length < 32)
    throw new Error(
      "The installation encryption secret is unavailable. Restore the Worker secret before continuing.",
    );
  const base = await crypto.subtle.importKey(
    "raw",
    encoder.encode(secret),
    "HKDF",
    false,
    ["deriveKey"],
  );
  return crypto.subtle.deriveKey(
    {
      name: "HKDF",
      hash: "SHA-256",
      salt: encoder.encode("unfoldmail-setup-v1"),
      info: encoder.encode("credentials"),
    },
    base,
    { name: "AES-GCM", length: 256 },
    false,
    ["encrypt", "decrypt"],
  );
}
export async function sealSetup(
  secret: string,
  value: string,
  context: string,
) {
  const iv = crypto.getRandomValues(new Uint8Array(12));
  const encrypted = new Uint8Array(
    await crypto.subtle.encrypt(
      { name: "AES-GCM", iv, additionalData: encoder.encode(context) },
      await key(secret),
      encoder.encode(value),
    ),
  );
  return "v1." + encode(iv) + "." + encode(encrypted);
}
export async function openSetup(
  secret: string,
  value: string,
  context: string,
) {
  const [version, iv, data] = value.split(".");
  if (version !== "v1" || !iv || !data)
    throw new Error("Invalid encrypted credential");
  return new TextDecoder().decode(
    await crypto.subtle.decrypt(
      {
        name: "AES-GCM",
        iv: decode(iv),
        additionalData: encoder.encode(context),
      },
      await key(secret),
      decode(data),
    ),
  );
}
