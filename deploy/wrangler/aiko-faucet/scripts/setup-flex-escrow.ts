#!/usr/bin/env tsx
// setup-flex-escrow.ts — one-shot operator setup. Creates the Flex escrow
// PDA, deposits initial funding, and registers the worker's wallet as a
// session key. Prints the escrow PDA address — paste it into CF Worker
// secrets as FLEX_ESCROW_ADDRESS.
//
// Usage:
//   FAUCET_PRIVATE_KEY=<base58_64_byte_keypair> \
//   FACILITATOR_ADDRESS=<unbrowse_facilitator_pubkey> \
//   INITIAL_DEPOSIT_USDC=10 \
//   npm run setup-escrow

import {
  createSolanaRpc,
  createSolanaRpcSubscriptions,
  createSignerFromKeyPair,
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
  some,
} from "@solana/kit";
import {
  getCreateEscrowInstructionAsync,
  getDepositInstructionAsync,
  getRegisterSessionKeyInstructionAsync,
  findEscrowsByOwner,
} from "@faremeter/flex-solana";
import { PublicKey } from "@solana/web3.js";
import { getAssociatedTokenAddressSync } from "@solana/spl-token";
import bs58 from "bs58";

const USDC_MINT = "EPjFWdd5AufqSSqeM2qN1xzybapC8G4wEGGkZwyTDt1v";
// Minimums per Flex program reference: ~150 slots (~1 min) refund, ~1000
// slots (~6.7 min) deadman with deadman >= 2 * refund.
const REFUND_TIMEOUT_SLOTS = 150n;
const DEADMAN_TIMEOUT_SLOTS = 1000n;

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
  const wsUrl = rpcUrl.replace(/^http/, "ws");
  const subs = createSolanaRpcSubscriptions(wsUrl);

  const secretBytes = bs58.decode(secretBs58);
  const keyPair = await createKeyPairFromBytes(secretBytes);
  const owner = await createSignerFromKeyPair(keyPair);
  console.log(`owner       : ${owner.address}`);
  console.log(`facilitator : ${facilitatorAddr}`);

  // 1) Create escrow PDA. The Flex program derives the PDA from
  // (owner, facilitator, index) so the same triplet always resolves
  // to the same address.
  const escrowIx = await getCreateEscrowInstructionAsync({
    owner,
    index: 0n,
    facilitator: address(facilitatorAddr),
    refundTimeoutSlots: REFUND_TIMEOUT_SLOTS,
    deadmanTimeoutSlots: DEADMAN_TIMEOUT_SLOTS,
    maxSessionKeys: 4,
  });
  // The PDA is the second account in the instruction; pull it.
  const escrowPda = escrowIx.accounts[1].address;
  console.log(`escrow PDA  : ${escrowPda}`);

  // 2) Deposit initial USDC. depositor's source ATA must be computed
  // explicitly — Flex's deposit instruction expects it as an account.
  const depositLamports = BigInt(Math.floor(depositUsdc * 1_000_000));
  const sourceAta = getAssociatedTokenAddressSync(
    new PublicKey(USDC_MINT),
    new PublicKey(owner.address),
  );
  const depositIx = await getDepositInstructionAsync({
    depositor: owner,
    escrow: escrowPda,
    mint: address(USDC_MINT),
    source: address(sourceAta.toBase58()),
    amount: depositLamports,
  });

  // 3) Register the owner's pubkey as session key for simplicity. For
  // higher security split into a separate session key — see README.
  // revocationGracePeriodSlots = ~2 min so in-flight authorizations
  // can settle after a key revoke.
  const sessionKeyIx = await getRegisterSessionKeyInstructionAsync({
    owner,
    escrow: escrowPda,
    sessionKey: owner.address,
    expiresAtSlot: some(0n),
    revocationGracePeriodSlots: 256n,
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
  // sendAndConfirmTransactionFactory's send takes (tx, config). Config
  // requires commitment per @solana/kit types.
  await send(tx, { commitment: "confirmed" });
  const sig = getSignatureFromTransaction(tx);
  console.log(`signature   : ${sig}`);

  // 4) Sanity-check that the escrow now resolves on-chain.
  const escrows = await findEscrowsByOwner(rpc, owner.address);
  const ours = escrows.find((e) => e.address === escrowPda);
  if (!ours) {
    console.error("escrow not found via findEscrowsByOwner after creation — check RPC commitment");
    process.exit(3);
  }
  console.log("\n>>> next step:");
  console.log(`>>> wrangler secret put FLEX_ESCROW_ADDRESS`);
  console.log(`>>> (paste: ${escrowPda})`);
}

main().catch((e) => { console.error(e); process.exit(1); });
