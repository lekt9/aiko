#!/usr/bin/env tsx
// setup-flex-escrow.ts — one-shot operator setup. Creates the Flex escrow
// PDA, deposits initial funding, and registers the worker's wallet as a
// session key. Output is the escrow PDA address — paste it into your
// CF Worker env as `FLEX_ESCROW_ADDRESS` so the worker can sign
// authorizations against it.
//
// Usage:
//   FAUCET_PRIVATE_KEY=<base58_64_byte_keypair> \
//   FACILITATOR_ADDRESS=<unbrowse_facilitator_pubkey> \
//   INITIAL_DEPOSIT_USDC=10 \
//   tsx scripts/setup-flex-escrow.ts
//
// Default network: Solana mainnet-beta. Override with RPC_URL.

import {
  createSolanaRpc,
  createSolanaRpcSubscriptions,
  createSignerFromKeyPair,
  generateKeyPairSigner,
  createKeyPairFromBytes,
  pipe,
  createTransactionMessage,
  setTransactionMessageFeePayerSigner,
  setTransactionMessageLifetimeUsingBlockhash,
  appendTransactionMessageInstructions,
  signTransactionMessageWithSigners,
  sendAndConfirmTransactionFactory,
  getSignatureFromTransaction,
  address,
} from "@solana/kit";
import {
  getCreateEscrowInstructionAsync,
  getDepositInstructionAsync,
  getRegisterSessionKeyInstructionAsync,
  findEscrowsByOwner,
  MIN_REFUND_TIMEOUT_SLOTS,
  MIN_DEADMAN_TIMEOUT_SLOTS,
} from "@faremeter/flex-solana";
import bs58 from "bs58";

const USDC_MINT = "EPjFWdd5AufqSSqeM2qN1xzybapC8G4wEGGkZwyTDt1v";

function env(k: string, required = true): string {
  const v = process.env[k];
  if (!v && required) {
    console.error(`missing required env: ${k}`);
    process.exit(2);
  }
  return v || "";
}

async function main() {
  const secretBs58 = env("FAUCET_PRIVATE_KEY");
  const facilitatorAddr = env("FACILITATOR_ADDRESS");
  const depositUsdc = Number(env("INITIAL_DEPOSIT_USDC", false) || "10");
  const rpcUrl = env("RPC_URL", false) || "https://api.mainnet-beta.solana.com";

  const rpc = createSolanaRpc(rpcUrl);
  const subs = createSolanaRpcSubscriptions(rpcUrl.replace("https://", "wss://"));

  const secretBytes = bs58.decode(secretBs58);
  const keyPair = await createKeyPairFromBytes(secretBytes);
  const owner = await createSignerFromKeyPair(keyPair);
  console.log(`owner       : ${owner.address}`);
  console.log(`facilitator : ${facilitatorAddr}`);

  // 1) Create escrow PDA (index=0, sane refund/deadman timeouts).
  const refundTimeoutSlots = BigInt(MIN_REFUND_TIMEOUT_SLOTS);             // ~1 min
  const deadmanTimeoutSlots = BigInt(MIN_DEADMAN_TIMEOUT_SLOTS) * 2n;       // ~13 min
  const escrowIx = await getCreateEscrowInstructionAsync({
    owner,
    facilitator: address(facilitatorAddr),
    index: 0n,
    refundTimeoutSlots,
    deadmanTimeoutSlots,
    maxSessionKeys: 4,
    maxPending: 16,
  });

  // 2) Deposit initial USDC into the escrow's vault.
  const depositLamports = BigInt(Math.floor(depositUsdc * 1_000_000));
  const depositIx = await getDepositInstructionAsync({
    owner,
    facilitator: address(facilitatorAddr),
    escrowIndex: 0n,
    mint: address(USDC_MINT),
    amount: depositLamports,
  });

  // 3) Register the SAME wallet as a session key for simplicity (the
  // faucet worker re-uses FAUCET_PRIVATE_KEY as session key inside
  // signFaremeterEnvelope). For higher security split these: register
  // a short-lived ed25519 keypair as the session key, store only its
  // private bytes in the CF Worker, never let the owner key touch
  // the worker.
  const sessionKeyIx = await getRegisterSessionKeyInstructionAsync({
    owner,
    facilitator: address(facilitatorAddr),
    escrowIndex: 0n,
    sessionKey: owner.address,
    expiresAtSlot: null,                       // no expiry
    revocationGracePeriodSlots: 256n,          // ~2 min
  });

  // Build, sign, send.
  const { value: blockhash } = await rpc.getLatestBlockhash().send();
  const msg = pipe(
    createTransactionMessage({ version: 0 }),
    (m) => setTransactionMessageFeePayerSigner(owner, m),
    (m) => setTransactionMessageLifetimeUsingBlockhash(blockhash, m),
    (m) => appendTransactionMessageInstructions([escrowIx, depositIx, sessionKeyIx], m),
  );
  const tx = await signTransactionMessageWithSigners(msg);
  const send = sendAndConfirmTransactionFactory({ rpc, rpcSubscriptions: subs });
  await send(tx, { commitment: "confirmed" });
  const sig = getSignatureFromTransaction(tx);
  console.log(`signature   : ${sig}`);

  // 4) Look up the escrow PDA address now that it exists on-chain.
  const escrows = await findEscrowsByOwner({ rpc, owner: owner.address });
  const ours = escrows.find((e) => e.facilitator === facilitatorAddr && e.index === 0n);
  if (!ours) {
    console.error("escrow not found after creation — check RPC");
    process.exit(3);
  }
  console.log(`escrow PDA  : ${ours.address}`);
  console.log("\n>>> next step: wrangler secret put FLEX_ESCROW_ADDRESS");
  console.log(`>>>            (paste: ${ours.address})`);
}

main().catch((e) => { console.error(e); process.exit(1); });
