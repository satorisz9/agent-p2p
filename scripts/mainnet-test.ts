import { P2PAgent } from "../src/agent/core";
import { SolanaClient } from "../src/lib/chain/solana";
import { Connection, LAMPORTS_PER_SOL } from "@solana/web3.js";
import type { AgentId, OrgId } from "../src/types/protocol";

async function main() {
  const agent = new P2PAgent({
    agentId: "agent:mindaxis:main" as AgentId,
    orgId: "org:mindaxis" as OrgId,
    namespace: "mainnet",
    dataDir: process.env.HOME + "/.agent-p2p/mainnet",
  });
  (agent as any).loadOrCreateState();

  const solana = new SolanaClient({ network: "mainnet-beta" });
  const kp = solana.keypairFromPrivateKey(agent.getPrivateKey());
  console.log("Wallet:", kp.publicKey.toBase58());

  // Use already-created token
  const result = { mintAddress: "GCCz5HFi7KnaFUXCDTKKs2QJ2kebDh2DvV3CXDJDyDjC", explorerUrl: "https://solscan.io/address/GCCz5HFi7KnaFUXCDTKKs2QJ2kebDh2DvV3CXDJDyDjC" };
  console.log("Using existing mint:", result.mintAddress);

  // Mint 1,000,000 tokens
  console.log("\nMinting 1,000,000 tokens...");
  const mintResult = await solana.mintTokens(kp, result.mintAddress, 1000000, 6);
  console.log("✓ Mint TX:", mintResult.txSignature);
  console.log("  Explorer:", mintResult.explorerUrl);

  // Check token balance
  const bal = await solana.getTokenBalance(kp.publicKey.toBase58(), result.mintAddress);
  console.log("\n✓ Token balance:", bal.amount);

  // Check remaining SOL
  const conn = new Connection("https://api.mainnet-beta.solana.com", "confirmed");
  const solBal = await conn.getBalance(kp.publicKey);
  console.log("  Remaining SOL:", solBal / LAMPORTS_PER_SOL);

  // Token info
  const info = await solana.getTokenInfo(result.mintAddress);
  console.log("\nToken Info:");
  console.log("  Supply:", info.supply);
  console.log("  Decimals:", info.decimals);
  console.log("  Mint Authority:", info.mintAuthority);
}

main().catch(e => {
  console.error("Error:", e.message);
  process.exit(1);
});
