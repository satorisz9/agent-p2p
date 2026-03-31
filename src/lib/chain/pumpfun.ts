/**
 * Pump.fun Integration — Launch meme tokens on Solana via pump.fun
 *
 * Provides:
 *   - Token creation with bonding curve (auto-liquidity)
 *   - Initial buy (creator buys first)
 *   - Buy/sell on existing pump.fun tokens
 *   - Bonding curve status queries
 */

import {
  Connection,
  Keypair,
  PublicKey,
  clusterApiUrl,
  LAMPORTS_PER_SOL,
} from "@solana/web3.js";
import { AnchorProvider, Wallet } from "@coral-xyz/anchor";
import { PumpFunSDK } from "pumpdotfun-sdk";
import type {
  CreateTokenMetadata,
  TransactionResult,
  PriorityFee,
} from "pumpdotfun-sdk";

export interface PumpFunConfig {
  rpcUrl?: string;
}

export interface LaunchResult {
  success: boolean;
  mintAddress?: string;
  txSignature?: string;
  bondingCurveAddress?: string;
  explorerUrl?: string;
  pumpFunUrl?: string;
  error?: string;
}

export interface TradeResult {
  success: boolean;
  txSignature?: string;
  explorerUrl?: string;
  error?: string;
}

export class PumpFunClient {
  private connection: Connection;
  private sdk: PumpFunSDK;

  constructor(config: PumpFunConfig = {}) {
    const url = config.rpcUrl || clusterApiUrl("mainnet-beta");
    this.connection = new Connection(url, "confirmed");

    // PumpFunSDK needs an AnchorProvider
    const dummyWallet = new Wallet(Keypair.generate());
    const provider = new AnchorProvider(this.connection, dummyWallet, {
      commitment: "confirmed",
    });
    this.sdk = new PumpFunSDK(provider);
  }

  /**
   * Launch a new token on pump.fun with bonding curve.
   *
   * @param creator - Keypair of the creator (pays fees + optional initial buy)
   * @param name - Token name (e.g. "Agent Coin")
   * @param symbol - Token symbol (e.g. "AGENT")
   * @param description - Token description
   * @param imageBuffer - Image file as Buffer
   * @param imageName - Image filename (e.g. "logo.png")
   * @param initialBuySol - SOL amount to buy initially (0 for no initial buy)
   * @param options - Optional: twitter, telegram, website, priority fees
   */
  async launch(
    creator: Keypair,
    name: string,
    symbol: string,
    description: string,
    imageBuffer: Buffer,
    imageName: string = "token.png",
    initialBuySol: number = 0,
    options: {
      twitter?: string;
      telegram?: string;
      website?: string;
      priorityFees?: PriorityFee;
      slippageBasisPoints?: number;
    } = {}
  ): Promise<LaunchResult> {
    try {
      // Generate a new mint keypair for the token
      const mint = Keypair.generate();

      // Build metadata with image blob
      const imageBlob = new Blob([new Uint8Array(imageBuffer)], { type: "image/png" });
      const metadata: CreateTokenMetadata = {
        name,
        symbol,
        description,
        file: imageBlob,
        twitter: options.twitter,
        telegram: options.telegram,
        website: options.website,
      };

      const buyAmountSol = BigInt(Math.round(initialBuySol * LAMPORTS_PER_SOL));
      const slippage = BigInt(options.slippageBasisPoints || 500); // 5% default

      const result: TransactionResult = await this.sdk.createAndBuy(
        creator,
        mint,
        metadata,
        buyAmountSol,
        slippage,
        options.priorityFees || { unitLimit: 250000, unitPrice: 250000 },
        "confirmed",
        "confirmed"
      );

      if (!result.success) {
        return {
          success: false,
          error: result.error ? String(result.error) : "Transaction failed",
        };
      }

      const mintAddress = mint.publicKey.toBase58();
      const bondingCurve = this.sdk.getBondingCurvePDA(mint.publicKey);

      return {
        success: true,
        mintAddress,
        txSignature: result.signature,
        bondingCurveAddress: bondingCurve.toBase58(),
        explorerUrl: `https://solscan.io/tx/${result.signature}`,
        pumpFunUrl: `https://pump.fun/coin/${mintAddress}`,
      };
    } catch (err: any) {
      return {
        success: false,
        error: err.message || String(err),
      };
    }
  }

  /**
   * Buy tokens on an existing pump.fun bonding curve.
   */
  async buy(
    buyer: Keypair,
    mintAddress: string,
    solAmount: number,
    slippageBasisPoints: number = 500
  ): Promise<TradeResult> {
    try {
      const mint = new PublicKey(mintAddress);
      const amount = BigInt(Math.round(solAmount * LAMPORTS_PER_SOL));
      const result = await this.sdk.buy(
        buyer,
        mint,
        amount,
        BigInt(slippageBasisPoints),
        { unitLimit: 250000, unitPrice: 250000 }
      );

      if (!result.success) {
        return { success: false, error: result.error ? String(result.error) : "Buy failed" };
      }
      return {
        success: true,
        txSignature: result.signature,
        explorerUrl: `https://solscan.io/tx/${result.signature}`,
      };
    } catch (err: any) {
      return { success: false, error: err.message || String(err) };
    }
  }

  /**
   * Sell tokens on an existing pump.fun bonding curve.
   */
  async sell(
    seller: Keypair,
    mintAddress: string,
    tokenAmount: number,
    slippageBasisPoints: number = 500
  ): Promise<TradeResult> {
    try {
      const mint = new PublicKey(mintAddress);
      // pump.fun tokens have 6 decimals
      const amount = BigInt(Math.round(tokenAmount * 1e6));
      const result = await this.sdk.sell(
        seller,
        mint,
        amount,
        BigInt(slippageBasisPoints),
        { unitLimit: 250000, unitPrice: 250000 }
      );

      if (!result.success) {
        return { success: false, error: result.error ? String(result.error) : "Sell failed" };
      }
      return {
        success: true,
        txSignature: result.signature,
        explorerUrl: `https://solscan.io/tx/${result.signature}`,
      };
    } catch (err: any) {
      return { success: false, error: err.message || String(err) };
    }
  }

  /**
   * Get bonding curve info for a pump.fun token.
   */
  async getBondingCurve(mintAddress: string): Promise<{
    exists: boolean;
    virtualSolReserves?: string;
    virtualTokenReserves?: string;
    realSolReserves?: string;
    realTokenReserves?: string;
    complete?: boolean;
  }> {
    try {
      const mint = new PublicKey(mintAddress);
      const curve = await this.sdk.getBondingCurveAccount(mint);
      if (!curve) return { exists: false };

      return {
        exists: true,
        virtualSolReserves: curve.virtualSolReserves.toString(),
        virtualTokenReserves: curve.virtualTokenReserves.toString(),
        realSolReserves: curve.realSolReserves.toString(),
        realTokenReserves: curve.realTokenReserves.toString(),
        complete: curve.complete,
      };
    } catch {
      return { exists: false };
    }
  }
}
