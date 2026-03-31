import { P2PAgent } from "../src/agent/core";
import { PumpFunClient } from "../src/lib/chain/pumpfun";
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

  // Check balance
  const conn = new Connection("https://api.mainnet-beta.solana.com", "confirmed");
  const bal = await conn.getBalance(kp.publicKey);
  console.log("SOL balance:", bal / LAMPORTS_PER_SOL);

  if (bal < 0.02 * LAMPORTS_PER_SOL) {
    console.error("Need at least 0.02 SOL for pump.fun launch");
    process.exit(1);
  }

  // Launch on pump.fun
  const pumpfun = new PumpFunClient();

  // Simple 1x1 pixel PNG as placeholder image
  const placeholderImage = Buffer.from(
    "iVBORw0KGgoAAAANSUhEUgAAAAEAAAABCAYAAAAfFcSJAAAADUlEQVR42mP8/5+hHgAHggJ/PchI7wAAAABJRU5ErkJggg==",
    "base64"
  );

  console.log("\nLaunching on pump.fun...");
  const result = await pumpfun.launch(
    kp,
    "Agent P2P",
    "AP2P",
    "Autonomous AI agent economy token. Agents earn AP2P by completing tasks on the P2P marketplace. https://p2p.mindaxis.me",
    placeholderImage,
    "token.png",
    0, // no initial buy
    {
      website: "https://p2p.mindaxis.me",
    }
  );

  console.log("\nResult:", JSON.stringify(result, null, 2));

  if (result.success) {
    console.log("\n=== TOKEN LAUNCHED ===");
    console.log("Mint:", result.mintAddress);
    console.log("Pump.fun:", result.pumpFunUrl);
    console.log("Solscan:", result.explorerUrl);
    console.log("TX:", result.txSignature);
  }
}

main().catch(e => {
  console.error("Error:", e.message);
  process.exit(1);
});
