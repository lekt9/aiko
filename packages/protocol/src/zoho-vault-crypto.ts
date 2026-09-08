/** Zoho Vault wire-format compatibility. See docs/password-manager-connections.md.
 * Pure WebCrypto: the master password is used only in the owner's browser. */
export type ZohoUnlockParameters = { salt: string; iterations: number };

export async function deriveZohoVaultKey(
  password: string,
  params: ZohoUnlockParameters,
) {
  if (
    !password ||
    password.length > 4096 ||
    typeof params.salt !== "string" ||
    !params.salt ||
    params.salt.length > 1024 ||
    !Number.isSafeInteger(params.iterations) ||
    params.iterations < 1 ||
    params.iterations > 10_000_000
  )
    throw new Error("Invalid vault unlock parameters");
  const material = await crypto.subtle.importKey(
    "raw",
    new TextEncoder().encode(password),
    "PBKDF2",
    false,
    ["deriveBits"],
  );
  const bits = await crypto.subtle.deriveBits(
    {
      name: "PBKDF2",
      hash: "SHA-256",
      salt: Uint8Array.from(params.salt, (char) => char.charCodeAt(0)),
      iterations: params.iterations,
    },
    material,
    256,
  );
  return Array.from(new Uint8Array(bits), (b) =>
    b.toString(16).padStart(2, "0"),
  ).join("");
}

/** Vault's AES format uses a derived ASCII key, an eight-byte nonce, and CESU-8. */
export async function decryptZohoVaultField(
  ciphertext: string,
  key: string,
): Promise<string> {
  if (
    typeof ciphertext !== "string" ||
    ciphertext.length > 100_000 ||
    typeof key !== "string" ||
    !key
  )
    throw new Error("Invalid encrypted vault field");
  if (!ciphertext) return "";
  const bytes: number[] = [];
  const normalizedKey = key.replace(/\r\n/g, "\n");
  for (let i = 0; i < normalizedKey.length; i++) {
    const c = normalizedKey.charCodeAt(i);
    if (c < 128) bytes.push(c);
    else if (c < 2048) bytes.push(192 | (c >> 6), 128 | (c & 63));
    else bytes.push(224 | (c >> 12), 128 | ((c >> 6) & 63), 128 | (c & 63));
  }
  const seed = new Uint8Array(32);
  seed.set(bytes.slice(0, 32));
  const seedKey = await crypto.subtle.importKey("raw", seed, "AES-CTR", false, [
    "encrypt",
  ]);
  const block = new Uint8Array(
    await crypto.subtle.encrypt(
      { name: "AES-CTR", counter: seed.slice(0, 16), length: 64 },
      seedKey,
      new Uint8Array(16),
    ),
  );
  const expanded = new Uint8Array(32);
  expanded.set(block);
  expanded.set(block, 16);
  const aes = await crypto.subtle.importKey("raw", expanded, "AES-CTR", false, [
    "decrypt",
  ]);
  const data = Uint8Array.from(atob(ciphertext), (c) => c.charCodeAt(0));
  if (data.length < 8) throw new Error("Invalid encrypted vault field");
  const counter = new Uint8Array(16);
  counter.set(data.slice(0, 8));
  const plain = new Uint8Array(
    await crypto.subtle.decrypt(
      { name: "AES-CTR", counter, length: 64 },
      aes,
      data.slice(8),
    ),
  );
  let result = "";
  for (let i = 0; i < plain.length;) {
    const c = plain[i++];
    if (c < 128) result += String.fromCharCode(c);
    else if (
      c >= 192 &&
      c < 224 &&
      i < plain.length &&
      (plain[i] & 192) === 128
    )
      result += String.fromCharCode(((c & 31) << 6) | (plain[i++] & 63));
    else if (
      c >= 224 &&
      c < 240 &&
      i + 1 < plain.length &&
      (plain[i] & 192) === 128 &&
      (plain[i + 1] & 192) === 128
    ) {
      result += String.fromCharCode(
        ((c & 15) << 12) | ((plain[i++] & 63) << 6) | (plain[i++] & 63),
      );
    } else throw new Error("Invalid encrypted vault field");
  }
  return result;
}
