/**
 * Solana On-Chain Client — SPL Token operations on devnet/mainnet.
 *
 * Provides:
 *   - Keypair management (generate, derive from agent Ed25519 key)
 *   - SOL airdrop (devnet only)
 *   - SPL token creation (mint)
 *   - SPL token minting (additional supply)
 *   - SPL token transfer
 *   - Balance queries
 *   - Explorer URL generation
 */

import {
  Connection,
  Keypair,
  PublicKey,
  LAMPORTS_PER_SOL,
  Transaction,
  sendAndConfirmTransaction,
  clusterApiUrl,
} from "@solana/web3.js";
import {
  createMint,
  getOrCreateAssociatedTokenAccount,
  getAssociatedTokenAddress,
  mintTo,
  transfer as splTransfer,
  getMint,
  getAccount,
  TOKEN_PROGRAM_ID,
} from "@solana/spl-token";

export type SolanaNetwork = "devnet" | "mainnet-beta";

export interface SolanaConfig {
  network: SolanaNetwork;
  rpcUrl?: string; // Custom RPC URL (overrides default cluster URL)
}

export interface TokenMintResult {
  mintAddress: string;
  txSignature: string;
  explorerUrl: string;
}

export interface TransferResult {
  txSignature: string;
  explorerUrl: string;
}

export class SolanaClient {
  private connection: Connection;
  private network: SolanaNetwork;

  constructor(config: SolanaConfig) {
    this.network = config.network;
    const url = config.rpcUrl || clusterApiUrl(config.network);
    this.connection = new Connection(url, "confirmed");
  }

  getNetwork(): SolanaNetwork {
    return this.network;
  }

  /**
   * Derive a Solana Keypair from an Ed25519 private key (64 bytes).
   * Solana keypairs ARE Ed25519, so we can directly use the 32-byte seed.
   */
  keypairFromPrivateKey(privateKeyBase64: string): Keypair {
    const raw = Buffer.from(privateKeyBase64, "base64");
    // Ed25519 private key is 64 bytes (32 seed + 32 public), Solana uses the full 64
    if (raw.length === 64) {
      return Keypair.fromSecretKey(new Uint8Array(raw));
    }
    // If only 32-byte seed, derive keypair from seed
    if (raw.length === 32) {
      return Keypair.fromSeed(new Uint8Array(raw));
    }
    throw new Error(`Invalid private key length: ${raw.length} (expected 32 or 64)`);
  }

  /**
   * Generate a fresh Solana keypair.
   */
  generateKeypair(): Keypair {
    return Keypair.generate();
  }

  /**
   * Get SOL balance in lamports.
   */
  async getSOLBalance(address: string): Promise<number> {
    const pubkey = new PublicKey(address);
    return this.connection.getBalance(pubkey);
  }

  /**
   * Airdrop SOL (devnet only). Returns tx signature.
   * Retries on 429 rate limit with exponential backoff.
   */
  async airdrop(address: string, solAmount: number = 1): Promise<string> {
    if (this.network !== "devnet") {
      throw new Error("Airdrop is only available on devnet");
    }
    const pubkey = new PublicKey(address);

    // Retry with backoff for devnet rate limits
    let lastError: Error | null = null;
    for (let attempt = 0; attempt < 5; attempt++) {
      try {
        const sig = await this.connection.requestAirdrop(
          pubkey,
          solAmount * LAMPORTS_PER_SOL
        );
        await this.connection.confirmTransaction(sig, "confirmed");
        return sig;
      } catch (err: any) {
        lastError = err;
        if (err.message?.includes("429") || err.message?.includes("Too Many Requests")) {
          const delay = 2000 * 2 ** attempt; // 2s, 4s, 8s, 16s, 32s
          console.error(`[Solana] Airdrop rate limited, retrying in ${delay}ms...`);
          await new Promise(r => setTimeout(r, delay));
          continue;
        }
        throw err;
      }
    }
    throw lastError || new Error("Airdrop failed after retries");
  }

  /**
   * Create a new SPL token (mint).
   * The payer/mintAuthority is the provided keypair.
   */
  async createToken(
    payer: Keypair,
    decimals: number = 9
  ): Promise<TokenMintResult> {
    const mint = await createMint(
      this.connection,
      payer,          // payer
      payer.publicKey, // mintAuthority
      payer.publicKey, // freezeAuthority (nullable)
      decimals
    );

    return {
      mintAddress: mint.toBase58(),
      txSignature: "", // createMint doesn't return the sig directly
      explorerUrl: this.explorerUrl("address", mint.toBase58()),
    };
  }

  /**
   * Mint additional tokens to the payer's associated token account.
   */
  async mintTokens(
    payer: Keypair,
    mintAddress: string,
    amount: number,
    decimals: number
  ): Promise<TransferResult> {
    const mint = new PublicKey(mintAddress);

    // Get or create the payer's associated token account
    const ata = await getOrCreateAssociatedTokenAccount(
      this.connection,
      payer,
      mint,
      payer.publicKey
    );

    // Mint tokens (amount is in raw units, so multiply by 10^decimals)
    const rawAmount = BigInt(Math.round(amount * 10 ** decimals));
    const sig = await mintTo(
      this.connection,
      payer,
      mint,
      ata.address,
      payer, // mintAuthority
      rawAmount
    );

    return {
      txSignature: sig,
      explorerUrl: this.explorerUrl("tx", sig),
    };
  }

  /**
   * Transfer SPL tokens to another wallet.
   */
  async transferTokens(
    sender: Keypair,
    mintAddress: string,
    recipientAddress: string,
    amount: number,
    decimals: number
  ): Promise<TransferResult> {
    const mint = new PublicKey(mintAddress);
    const recipient = new PublicKey(recipientAddress);

    // Get or create associated token accounts
    const senderAta = await getOrCreateAssociatedTokenAccount(
      this.connection,
      sender,
      mint,
      sender.publicKey
    );

    const recipientAta = await getOrCreateAssociatedTokenAccount(
      this.connection,
      sender, // payer for creating recipient's ATA if needed
      mint,
      recipient
    );

    const rawAmount = BigInt(Math.round(amount * 10 ** decimals));
    const sig = await splTransfer(
      this.connection,
      sender,
      senderAta.address,
      recipientAta.address,
      sender,
      rawAmount
    );

    return {
      txSignature: sig,
      explorerUrl: this.explorerUrl("tx", sig),
    };
  }

  /**
   * Get SPL token balance for a wallet.
   */
  async getTokenBalance(
    ownerAddress: string,
    mintAddress: string
  ): Promise<{ amount: number; rawAmount: string; decimals: number }> {
    const owner = new PublicKey(ownerAddress);
    const mint = new PublicKey(mintAddress);

    try {
      // Derive ATA address without creating it
      const ataAddress = await getAssociatedTokenAddress(mint, owner);
      const account = await getAccount(this.connection, ataAddress);
      const mintInfo = await getMint(this.connection, mint);
      const rawAmount = account.amount.toString();
      const amount = Number(account.amount) / 10 ** mintInfo.decimals;
      return { amount, rawAmount, decimals: mintInfo.decimals };
    } catch (err: any) {
      // Account doesn't exist = 0 balance
      if (err.message?.includes("could not find account") ||
          err.name === "TokenAccountNotFoundError") {
        return { amount: 0, rawAmount: "0", decimals: 0 };
      }
      throw err;
    }
  }

  /**
   * Get token info (supply, decimals, etc.)
   */
  async getTokenInfo(mintAddress: string): Promise<{
    supply: string;
    decimals: number;
    mintAuthority: string | null;
    freezeAuthority: string | null;
  }> {
    const mint = await getMint(this.connection, new PublicKey(mintAddress));
    return {
      supply: mint.supply.toString(),
      decimals: mint.decimals,
      mintAuthority: mint.mintAuthority?.toBase58() ?? null,
      freezeAuthority: mint.freezeAuthority?.toBase58() ?? null,
    };
  }

  /**
   * Generate explorer URL for a transaction or address.
   */
  explorerUrl(type: "tx" | "address", value: string): string {
    const cluster = this.network === "devnet" ? "?cluster=devnet" : "";
    return `https://solscan.io/${type}/${value}${cluster}`;
  }
}
