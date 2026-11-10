/* AES-256-GCM decrypt for the published data. Blob = 12-byte nonce || ciphertext+tag. Key = base64url (32 bytes).
   Same file runs in the browser (window.DeskCrypto) and in Node >= 19 for the round-trip test. */
(function (root) {
  "use strict";
  const subtle = (root.crypto || globalThis.crypto).subtle;
  function unb64u(s) {
    s = String(s).replace(/-/g, "+").replace(/_/g, "/");
    while (s.length % 4) s += "=";
    const bin = atob(s), out = new Uint8Array(bin.length);
    for (let i = 0; i < bin.length; i++) out[i] = bin.charCodeAt(i);
    return out;
  }
  const keys = {};
  async function importKey(k) {
    if (!keys[k]) {
      const raw = unb64u(k);
      if (raw.length !== 32) throw new Error("bad key");
      keys[k] = subtle.importKey("raw", raw, { name: "AES-GCM" }, false, ["decrypt"]);
    }
    return keys[k];
  }
  async function decrypt(k, buf) {
    const b = new Uint8Array(buf);
    if (b.length < 12 + 16) throw new Error("short blob");
    const pt = await subtle.decrypt({ name: "AES-GCM", iv: b.slice(0, 12) }, await importKey(k), b.slice(12));
    return new TextDecoder().decode(pt);
  }
  async function decryptJSON(k, buf) { return JSON.parse(await decrypt(k, buf)); }
  const api = { decrypt, decryptJSON };
  if (typeof module !== "undefined" && module.exports) module.exports = api; else root.DeskCrypto = api;
})(typeof window !== "undefined" ? window : globalThis);
