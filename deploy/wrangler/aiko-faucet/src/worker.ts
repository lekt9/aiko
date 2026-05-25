// aiko-faucet — Manna-pattern USDC faucet for the aiko substrate.
//
// One source wallet, daily per-IP allowance, no hoarding (KV TTL = 24h).
// Auto-pays x402 envelopes on behalf of callers within their allowance,
// so an aiko client just calls /v1/contract/declare on this worker
// (instead of beta-api.unbrowse.ai directly) and gets a 200 back without
// having to sign payments themselves.
//
// Doctrine: Manna (Exodus 16:4) — "I will rain bread from heaven for you;
// and the people shall go out and gather a certain rate every day". The
// IP is the Israelite, the omer is DAILY_LIMIT_USDC, the rate is per-call
// (x402 amount per declare), the rotting overnight is the KV TTL.

import {
  Connection, Keypair, PublicKey, Transaction, sendAndConfirmTransaction,
} from "@solana/web3.js";
import {
  createTransferInstruction, getAssociatedTokenAddress,
  createAssociatedTokenAccountInstruction,
} from "@solana/spl-token";
import bs58 from "bs58";
import {
  serializePaymentAuthorization,
  signPaymentAuthorization,
  FLEX_PROGRAM_ADDRESS,
} from "@faremeter/flex-solana";
import { address as solAddress } from "@solana/kit";

export interface Env {
  AIKO_FAUCET_KV: KVNamespace;
  FAUCET_PRIVATE_KEY: string;     // base58 Solana keypair (64 bytes) — owner + session key
  FLEX_ESCROW_ADDRESS: string;    // PDA from scripts/setup-flex-escrow.ts
  UPSTREAM_BASE: string;
  DAILY_LIMIT_USDC: string;
  USDC_MINT: string;
  SOLANA_RPC: string;
  TTL_SECONDS: string;
  HOURLY_LIMIT: string;
  WINDOW_SECONDS: string;
}

const USDC_DECIMALS = 6;
const usdcToBase = (usdc: number): bigint => BigInt(Math.floor(usdc * 10 ** USDC_DECIMALS));

function ipKey(ip: string) { return `faucet:ip:${ip}`; }
function rcptKey(rcpt: string) { return `faucet:rcpt:${rcpt}`; }

interface ClaimState {
  ip: string;
  granted_at: number;        // unix seconds
  total_granted_base: string;  // bigint as string (USDC base units)
  spent_base: string;          // bigint, how much paid out via x402 so far
  recipient?: string;          // solana pubkey base58
  tx?: string;                 // funding tx signature
}

async function getClaim(env: Env, ip: string): Promise<ClaimState | null> {
  const raw = await env.AIKO_FAUCET_KV.get(ipKey(ip));
  return raw ? JSON.parse(raw) : null;
}

async function putClaim(env: Env, ip: string, claim: ClaimState) {
  const ttl = parseInt(env.TTL_SECONDS, 10);
  await env.AIKO_FAUCET_KV.put(ipKey(ip), JSON.stringify(claim), { expirationTtl: ttl });
}

async function sourceKeypair(env: Env): Promise<Keypair> {
  const secret = bs58.decode(env.FAUCET_PRIVATE_KEY);
  return Keypair.fromSecretKey(secret);
}

// POST /v1/faucet/claim — body: {"public_key": "<solana base58>"}
// Sends DAILY_LIMIT_USDC from source wallet to recipient; records IP claim.
async function handleClaim(req: Request, env: Env, ip: string): Promise<Response> {
  const existing = await getClaim(env, ip);
  if (existing) {
    return Response.json({
      ok: false, error: "already_claimed_today",
      remaining_base: (BigInt(existing.total_granted_base) - BigInt(existing.spent_base)).toString(),
      doctrine: "Manna — yesterday's omer rotted; come back at sunset (TTL expiry).",
    }, { status: 429 });
  }

  const body = (await req.json().catch(() => ({}))) as { public_key?: string };
  if (!body.public_key) {
    return Response.json({ ok: false, error: "missing public_key" }, { status: 400 });
  }

  let recipient: PublicKey;
  try { recipient = new PublicKey(body.public_key); }
  catch { return Response.json({ ok: false, error: "invalid public_key" }, { status: 400 }); }

  const source = await sourceKeypair(env);
  const conn = new Connection(env.SOLANA_RPC, "confirmed");
  const mint = new PublicKey(env.USDC_MINT);
  const amount = usdcToBase(parseFloat(env.DAILY_LIMIT_USDC));

  const fromAta = await getAssociatedTokenAddress(mint, source.publicKey);
  const toAta = await getAssociatedTokenAddress(mint, recipient);

  const tx = new Transaction();
  const toInfo = await conn.getAccountInfo(toAta);
  if (!toInfo) {
    tx.add(createAssociatedTokenAccountInstruction(source.publicKey, toAta, recipient, mint));
  }
  tx.add(createTransferInstruction(fromAta, toAta, source.publicKey, amount));

  let sig: string;
  try {
    sig = await sendAndConfirmTransaction(conn, tx, [source]);
  } catch (e: any) {
    return Response.json({ ok: false, error: "transfer_failed", detail: String(e?.message || e) }, { status: 502 });
  }

  const claim: ClaimState = {
    ip,
    granted_at: Math.floor(Date.now() / 1000),
    total_granted_base: amount.toString(),
    spent_base: "0",
    recipient: body.public_key,
    tx: sig,
  };
  await putClaim(env, ip, claim);
  await env.AIKO_FAUCET_KV.put(rcptKey(body.public_key), ip, { expirationTtl: parseInt(env.TTL_SECONDS, 10) });

  return Response.json({
    ok: true,
    tx: sig,
    amount_usdc: env.DAILY_LIMIT_USDC,
    recipient: body.public_key,
    ttl_seconds: parseInt(env.TTL_SECONDS, 10),
    doctrine: "Manna granted — gather only your omer; tomorrow comes fresh.",
  });
}

// GET /v1/faucet/balance — show remaining allowance for the caller IP.
async function handleBalance(env: Env, ip: string): Promise<Response> {
  const claim = await getClaim(env, ip);
  if (!claim) {
    return Response.json({ ok: true, claimed: false, daily_limit_usdc: env.DAILY_LIMIT_USDC });
  }
  const remaining = (BigInt(claim.total_granted_base) - BigInt(claim.spent_base)).toString();
  return Response.json({
    ok: true,
    claimed: true,
    granted_at: claim.granted_at,
    remaining_base: remaining,
    recipient: claim.recipient,
  });
}

// Sliding-window rate limit per IP. Stores hit-timestamps in KV under
// `rate:ip:<ip>` as a JSON array; on each call, prunes timestamps older
// than WINDOW_SECONDS and rejects if the remaining count >= HOURLY_LIMIT.
async function checkRateLimit(env: Env, ip: string): Promise<{ ok: boolean; remaining: number; reset_in_seconds: number }> {
  const key = `rate:ip:${ip}`;
  const windowSecs = parseInt(env.WINDOW_SECONDS || "3600", 10);
  const limit = parseInt(env.HOURLY_LIMIT || "10", 10);
  const nowSecs = Math.floor(Date.now() / 1000);
  const cutoff = nowSecs - windowSecs;
  const raw = await env.AIKO_FAUCET_KV.get(key);
  const hits: number[] = raw ? JSON.parse(raw) : [];
  const recent = hits.filter((t) => t >= cutoff);
  if (recent.length >= limit) {
    const oldest = recent[0];
    return { ok: false, remaining: 0, reset_in_seconds: oldest + windowSecs - nowSecs };
  }
  recent.push(nowSecs);
  await env.AIKO_FAUCET_KV.put(key, JSON.stringify(recent), { expirationTtl: windowSecs * 2 });
  return { ok: true, remaining: limit - recent.length, reset_in_seconds: windowSecs };
}

// POST /v1/contract/declare — proxy to Unbrowse with IP-rate-limit + auto
// x402 signing. Local aikos that hit a 402 chain here transparently;
// each IP gets HOURLY_LIMIT calls per WINDOW_SECONDS (default 10/hour).
// Doctrine: Manna gathered just-in-time, not stockpiled.
async function handleDeclare(req: Request, env: Env, ip: string): Promise<Response> {
  // 1. Rate-limit by IP first — cheapest gate, no upstream cost on reject.
  const gate = await checkRateLimit(env, ip);
  if (!gate.ok) {
    return Response.json({
      error: "rate_limit_exceeded",
      remaining: 0,
      reset_in_seconds: gate.reset_in_seconds,
      doctrine: "Manna — gather only your omer; tomorrow comes fresh.",
    }, { status: 429, headers: { "Retry-After": String(gate.reset_in_seconds) } });
  }
  const upstream = `${env.UPSTREAM_BASE}/v1/contract/declare`;
  const body = await req.arrayBuffer();
  const headers = new Headers(req.headers);
  headers.set("x-client", "aiko");
  headers.set("x-faucet-ip", ip);
  headers.set("x-faucet-remaining", String(gate.remaining));

  let resp = await fetch(upstream, { method: "POST", headers, body });
  if (resp.status !== 402) return resp;

  const env_402 = await resp.json<any>();
  const claim = await getClaim(env, ip);
  if (!claim) {
    return Response.json({
      ...env_402,
      hint: `no faucet claim for IP ${ip}; POST /v1/faucet/claim with {public_key}`,
      doctrine: "Gather your omer first.",
    }, { status: 402 });
  }
  const need = BigInt(env_402.accepts?.[0]?.amount || "1000");
  const remaining = BigInt(claim.total_granted_base) - BigInt(claim.spent_base);
  if (remaining < need) {
    return Response.json({
      ...env_402,
      hint: "daily allowance exhausted; wait for TTL expiry (manna rots overnight).",
    }, { status: 402 });
  }

  // Build x402 payment header from source wallet. Faremeter-flex envelope.
  // NOTE: this is a STUB — the actual envelope signing for @faremeter/flex
  // needs the Faremeter SDK call shape; left as a clear marker so the
  // operator can plug it in. The accounting (KV decrement) is wired.
  const payment_header = await signFaremeterEnvelope(env, env_402.accepts[0], need);

  headers.set("x-payment", payment_header);
  resp = await fetch(upstream, { method: "POST", headers, body });

  if (resp.status >= 200 && resp.status < 300) {
    claim.spent_base = (BigInt(claim.spent_base) + need).toString();
    await putClaim(env, ip, claim);
  }
  return resp;
}

/// Sign a Faremeter Flex authorization envelope for x402.
///
/// Wire format (verified against faremeter/flex@main): the FlexAuthorization
/// is a binary message serialized as:
///   [32B] programId || [32B] escrow || [32B] mint || [u64LE] maxAmount ||
///   [u64LE] authorizationId || [u64LE] expiresAtSlot || [u32LE] splitCount ||
///   for each split: [32B] recipient || [u16LE] bps
///
/// The session key signs that binary blob (Ed25519). The envelope JSON is:
///   { x402Version, scheme:"@faremeter/flex", network, asset, payload: {
///     escrow, mint, maxAmount, authorizationId, expiresAtSlot,
///     splits:[{recipient,bps}], sessionKey, signature
///   } }
/// Base64-encoded as the X-PAYMENT header.
///
/// FLEX_PROGRAM_ADDRESS = EcfUgNgDXmBx4Xns2qZLE54xpM7V1N6PL8MdDW1syujS
///
/// Per substrate canon FOUNDRY_CUT_BPS=5000 — every authorization gets a
/// 50% split to the Foundry treasury before any client destination.
async function signFaremeterEnvelope(env: Env, accepts: any, amount: bigint): Promise<string> {
  // The source wallet's keypair acts as the registered session key.
  // (In production, the session key is a separate Ed25519 keypair the
  // client registers on-chain via getRegisterSessionKeyInstructionAsync;
  // for the faucet's auto-sign path we use the source wallet directly.)
  const source = await sourceKeypair(env);

  // Import the source's secret into a Web Crypto Ed25519 keypair so the
  // canonical signPaymentAuthorization can use it. The Solana secretKey
  // is 64 bytes: first 32 are the seed, last 32 are the pubkey; Ed25519
  // raw-import takes the seed.
  const secretKeyRaw = new Uint8Array(source.secretKey.slice(0, 32));
  const pubKeyRaw = new Uint8Array(source.publicKey.toBytes());
  const privKey = await crypto.subtle.importKey(
    "raw", secretKeyRaw.buffer as ArrayBuffer,
    { name: "Ed25519" }, false, ["sign"],
  );
  const pubKey = await crypto.subtle.importKey(
    "raw", pubKeyRaw.buffer as ArrayBuffer,
    { name: "Ed25519" }, true, ["verify"],
  );
  const keyPair: CryptoKeyPair = { privateKey: privKey, publicKey: pubKey };

  // Parse Flex requirements from the 402 envelope. accepts.extra carries
  // facilitator + escrow per FlexPaymentRequirementsExtra.
  // Prefer the operator-configured escrow PDA over the 402 advertisement —
  // env.FLEX_ESCROW_ADDRESS is the escrow our session key is registered on.
  const extra = accepts.extra || {};
  const escrow = env.FLEX_ESCROW_ADDRESS || extra.escrow || accepts.payTo;
  if (!env.FLEX_ESCROW_ADDRESS) {
    console.warn("FLEX_ESCROW_ADDRESS not set; falling back to 402 advertisement — run setup-flex-escrow.ts");
  }
  const mint = accepts.asset;
  const splitsAdvertised = extra.splits || [];

  // Compose final splits: enforce the 50% Foundry cut at the front, then
  // append the advertised destinations scaled to remaining 5000 bps.
  const FOUNDRY_CUT_BPS = 5000;
  const FOUNDRY_CUT_ADDRESS = "2ZiSPGncrkwWa6GBZB4EDtsfq7HEWwkwsPFzEXieXjNL";
  const splits = [{ recipient: FOUNDRY_CUT_ADDRESS, bps: FOUNDRY_CUT_BPS }];
  if (splitsAdvertised.length === 0) {
    splits.push({ recipient: accepts.payTo, bps: 10000 - FOUNDRY_CUT_BPS });
  } else {
    const remaining = 10000 - FOUNDRY_CUT_BPS;
    const totalAdv = splitsAdvertised.reduce((a: number, s: any) => a + s.bps, 0);
    for (const s of splitsAdvertised) {
      splits.push({ recipient: s.recipient, bps: Math.floor((s.bps * remaining) / totalAdv) });
    }
    // Round-off the dust into the last split so sum is exactly 10000.
    const sum = splits.reduce((a, s) => a + s.bps, 0);
    if (sum !== 10000) splits[splits.length - 1].bps += 10000 - sum;
  }

  // Random u64 authorizationId (replay protection via PDA seed on-chain).
  const idBytes = new Uint8Array(8);
  crypto.getRandomValues(idBytes);
  const authorizationId = new DataView(idBytes.buffer).getBigUint64(0, true);

  // expiresAtSlot — facilitator clamps to <= current_slot + refund_timeout.
  // We pass 0 to defer; the facilitator will reject if it requires explicit.
  const expiresAtSlot = 0n;

  const serArgs = {
    programId: solAddress(FLEX_PROGRAM_ADDRESS as unknown as string),
    escrow: solAddress(escrow),
    mint: solAddress(mint),
    maxAmount: amount,
    authorizationId,
    expiresAtSlot,
    splits: splits.map((s) => ({ recipient: solAddress(s.recipient), bps: s.bps })),
  };

  const message = serializePaymentAuthorization(serArgs as any);
  const signature = await signPaymentAuthorization({ keyPair, message });

  const payload = {
    escrow,
    mint,
    maxAmount: amount.toString(),
    authorizationId: authorizationId.toString(),
    expiresAtSlot: expiresAtSlot.toString(),
    splits,
    sessionKey: source.publicKey.toBase58(),
    signature: bs58.encode(signature),
  };

  const envelope = {
    x402Version: 2,
    scheme: "@faremeter/flex",
    network: accepts.network,
    asset: accepts.asset,
    payload,
  };

  return btoa(JSON.stringify(envelope));
}

export default {
  async fetch(req: Request, env: Env): Promise<Response> {
    const url = new URL(req.url);
    const ip = req.headers.get("cf-connecting-ip") || req.headers.get("x-forwarded-for")?.split(",")[0] || "0.0.0.0";

    if (url.pathname === "/v1/faucet/claim" && req.method === "POST") return handleClaim(req, env, ip);
    if (url.pathname === "/v1/faucet/balance" && req.method === "GET") return handleBalance(env, ip);
    if (url.pathname === "/v1/contract/declare" && req.method === "POST") return handleDeclare(req, env, ip);

    return Response.json({
      service: "aiko-faucet",
      doctrine: "Manna (Exodus 16:4) — daily ration from one source.",
      endpoints: ["POST /v1/faucet/claim", "GET /v1/faucet/balance", "POST /v1/contract/declare"],
    });
  },
};
