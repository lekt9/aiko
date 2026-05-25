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

export interface Env {
  AIKO_FAUCET_KV: KVNamespace;
  FAUCET_PRIVATE_KEY: string;     // base58 Solana keypair (64 bytes)
  UPSTREAM_BASE: string;
  DAILY_LIMIT_USDC: string;
  USDC_MINT: string;
  SOLANA_RPC: string;
  TTL_SECONDS: string;
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

  const body = await req.json<{ public_key?: string }>().catch(() => ({}));
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

// POST /v1/contract/declare — proxy to Unbrowse; if 402 and the IP has
// a faucet claim with remaining allowance, sign an x402 envelope on the
// caller's behalf and retry. Doctrine: the manna gathered yesterday is
// already inside you; the x402 envelope is just the morsel you swallow.
async function handleDeclare(req: Request, env: Env, ip: string): Promise<Response> {
  const upstream = `${env.UPSTREAM_BASE}/v1/contract/declare`;
  const body = await req.arrayBuffer();
  const headers = new Headers(req.headers);
  headers.set("x-client", "aiko");

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

/// Build + sign an x402 / Faremeter Flex envelope for Solana.
///
/// The Flex scheme for SVM transports a pre-signed SPL transfer transaction
/// inside the envelope payload. The facilitator (corbits-faremeter-flex)
/// validates the signature, broadcasts the tx, then forwards the underlying
/// HTTP request once on-chain.
///
/// Envelope shape per x402 v2 + Faremeter conventions:
///   { x402Version, scheme: "@faremeter/flex", network, payload: {
///       signedTransaction: <base64>,
///       payer:    <source pubkey base58>,
///       payTo:    <recipient base58>,
///       amount:   <stringified base units>,
///       asset:    <mint base58>,
///       nonce:    <uuid>
///   } }
///
/// The whole envelope is JSON-stringified then base64-encoded; that base64
/// string is the value of the X-PAYMENT header. The facilitator's spec is
/// the source of truth; this implementation is best-effort against the
/// public envelope shape observed on the 402 response.
async function signFaremeterEnvelope(env: Env, accepts: any, amount: bigint): Promise<string> {
  const source = await sourceKeypair(env);
  const conn = new Connection(env.SOLANA_RPC, "confirmed");
  const mint = new PublicKey(accepts.asset);
  const payTo = new PublicKey(accepts.payTo);

  const fromAta = await getAssociatedTokenAddress(mint, source.publicKey);
  const toAta = await getAssociatedTokenAddress(mint, payTo);

  const tx = new Transaction();
  const toInfo = await conn.getAccountInfo(toAta);
  if (!toInfo) {
    // Source pays rent for the recipient's ATA. Tiny one-time cost; same
    // wallet that funds the faucet covers it.
    tx.add(createAssociatedTokenAccountInstruction(source.publicKey, toAta, payTo, mint));
  }
  tx.add(createTransferInstruction(fromAta, toAta, source.publicKey, amount));

  const { blockhash } = await conn.getLatestBlockhash("confirmed");
  tx.recentBlockhash = blockhash;
  tx.feePayer = source.publicKey;
  tx.sign(source);

  const serialized = tx.serialize();
  const signedTxB64 = btoa(String.fromCharCode(...new Uint8Array(serialized)));

  const envelope = {
    x402Version: 2,
    scheme: "@faremeter/flex",
    network: accepts.network,
    payload: {
      signedTransaction: signedTxB64,
      payer: source.publicKey.toBase58(),
      payTo: accepts.payTo,
      amount: amount.toString(),
      asset: accepts.asset,
      nonce: crypto.randomUUID(),
    },
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
