/**
 * Pump.fun Integration — Launch meme tokens on Solana via pump.fun
 *
 * Provides:
 *   - Token creation with bonding curve (auto-liquidity)
 *   - Buy/sell on existing pump.fun tokens
 *   - Bonding curve status queries
 *
 * Note: buy/sell are implemented directly (not via SDK) because
 * pump.fun added global_volume_accumulator which the SDK doesn't support yet.
 */

import {
  Connection,
  Keypair,
  PublicKey,
  clusterApiUrl,
  LAMPORTS_PER_SOL,
  Transaction,
  TransactionInstruction,
  SystemProgram,
  sendAndConfirmTransaction,
  ComputeBudgetProgram,
} from "@solana/web3.js";
import {
  getAssociatedTokenAddress,
  createAssociatedTokenAccountInstruction,
  getAccount,
  TOKEN_PROGRAM_ID,
  ASSOCIATED_TOKEN_PROGRAM_ID,
} from "@solana/spl-token";
import { AnchorProvider, Wallet } from "@coral-xyz/anchor";
import { PumpFunSDK } from "pumpdotfun-sdk";
import type {
  CreateTokenMetadata,
  TransactionResult,
  PriorityFee,
} from "pumpdotfun-sdk";

const PUMP_PROGRAM_ID = new PublicKey("6EF8rrecthR5Dkzon8Nwu78hRvfCKubJ14M5uBEwF6P");
const PUMP_GLOBAL = new PublicKey("4wTV1YmiEkRvAtNtsSGPtUrqRYQMe5SKy2uB4Jjaxnjf");
const PUMP_FEE_RECIPIENT = new PublicKey("CebN5WGQ4jvEPvsVU4EoHEpgzq1VV7AbCJ8idM5rnGWj");
const PUMP_EVENT_AUTHORITY = new PublicKey("Ce6TQqeHC9p8KetsN6JsjHK7UTZk7nasjjnr7XxXp9F1");
const PUMP_MINT_AUTHORITY = PublicKey.findProgramAddressSync(
  [Buffer.from("mint-authority")], PUMP_PROGRAM_ID
)[0];

// Global volume accumulator — new required account (program update)
// PDA: seeds=["global_volume_accumulator"], program=6EF8rrecth...
const GLOBAL_VOLUME_ACCUMULATOR = new PublicKey("Hq2wp8uJ9jCPsYgNHex8RtqdvMPfVGoYwjvF1ATiwn2Y");

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

// Buy instruction discriminator (Anchor: hash("global:buy")[0..8])
const BUY_DISCRIMINATOR = Buffer.from([102, 6, 61, 18, 1, 218, 235, 234]);
// Sell instruction discriminator
const SELL_DISCRIMINATOR = Buffer.from([51, 230, 133, 164, 1, 127, 131, 173]);

export class PumpFunClient {
  private connection: Connection;
  private sdk: PumpFunSDK;

  constructor(config: PumpFunConfig = {}) {
    const url = config.rpcUrl || clusterApiUrl("mainnet-beta");
    this.connection = new Connection(url, "confirmed");

    const dummyWallet = new Wallet(Keypair.generate());
    const provider = new AnchorProvider(this.connection, dummyWallet, {
      commitment: "confirmed",
    });
    this.sdk = new PumpFunSDK(provider);
  }

  /**
   * Launch a new token on pump.fun with bonding curve.
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
      const mint = Keypair.generate();
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
      const slippage = BigInt(options.slippageBasisPoints || 500);

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
      return { success: false, error: err.message || String(err) };
    }
  }

  /**
   * Buy tokens on pump.fun bonding curve.
   * Built directly (not via SDK) to include global_volume_accumulator.
   */
  async buy(
    buyer: Keypair,
    mintAddress: string,
    solAmount: number,
    slippageBasisPoints: number = 500
  ): Promise<TradeResult> {
    try {
      const mint = new PublicKey(mintAddress);
      const bondingCurve = this.sdk.getBondingCurvePDA(mint);
      const associatedBondingCurve = await getAssociatedTokenAddress(mint, bondingCurve, true);
      const associatedUser = await getAssociatedTokenAddress(mint, buyer.publicKey, false);

      // Get bonding curve state to calculate token amount
      const curveAccount = await this.sdk.getBondingCurveAccount(mint);
      if (!curveAccount) throw new Error("Bonding curve not found");

      const globalAccount = await this.sdk.getGlobalAccount();
      const buyAmountSol = BigInt(Math.round(solAmount * LAMPORTS_PER_SOL));
      const buyAmount = curveAccount.getBuyPrice(buyAmountSol);
      const maxSolCost = buyAmountSol + (buyAmountSol * BigInt(slippageBasisPoints) / 10000n);

      const tx = new Transaction();

      // Compute budget
      tx.add(ComputeBudgetProgram.setComputeUnitLimit({ units: 250000 }));
      tx.add(ComputeBudgetProgram.setComputeUnitPrice({ microLamports: 250000 }));

      // Create ATA if needed
      try {
        await getAccount(this.connection, associatedUser);
      } catch {
        tx.add(createAssociatedTokenAccountInstruction(
          buyer.publicKey, associatedUser, buyer.publicKey, mint
        ));
      }

      // Encode buy instruction data: discriminator + amount (u64) + maxSolCost (u64)
      const data = Buffer.alloc(8 + 8 + 8);
      BUY_DISCRIMINATOR.copy(data, 0);
      data.writeBigUInt64LE(buyAmount, 8);
      data.writeBigUInt64LE(maxSolCost, 16);

      const SYSVAR_RENT = new PublicKey("SysvarRent111111111111111111111111111111111");
      tx.add(new TransactionInstruction({
        programId: PUMP_PROGRAM_ID,
        keys: [
          { pubkey: PUMP_GLOBAL, isSigner: false, isWritable: false },          // 0: global
          { pubkey: globalAccount.feeRecipient, isSigner: false, isWritable: true }, // 1: fee_recipient
          { pubkey: mint, isSigner: false, isWritable: false },                  // 2: mint
          { pubkey: bondingCurve, isSigner: false, isWritable: true },           // 3: bonding_curve
          { pubkey: associatedBondingCurve, isSigner: false, isWritable: true }, // 4: associated_bonding_curve
          { pubkey: associatedUser, isSigner: false, isWritable: true },         // 5: associated_user
          { pubkey: buyer.publicKey, isSigner: true, isWritable: true },         // 6: user
          { pubkey: SystemProgram.programId, isSigner: false, isWritable: false }, // 7: system_program
          { pubkey: TOKEN_PROGRAM_ID, isSigner: false, isWritable: false },      // 8: token_program
          { pubkey: SYSVAR_RENT, isSigner: false, isWritable: false },           // 9: rent
          { pubkey: PUMP_EVENT_AUTHORITY, isSigner: false, isWritable: false },  // 10: event_authority
          { pubkey: PUMP_PROGRAM_ID, isSigner: false, isWritable: false },       // 11: program
          // remaining accounts:
          { pubkey: GLOBAL_VOLUME_ACCUMULATOR, isSigner: false, isWritable: true },
        ],
        data,
      }));

      const sig = await sendAndConfirmTransaction(this.connection, tx, [buyer], {
        commitment: "confirmed",
      });

      return {
        success: true,
        txSignature: sig,
        explorerUrl: `https://solscan.io/tx/${sig}`,
      };
    } catch (err: any) {
      return { success: false, error: err.message || String(err) };
    }
  }

  /**
   * Sell tokens on pump.fun bonding curve.
   */
  async sell(
    seller: Keypair,
    mintAddress: string,
    tokenAmount: number,
    slippageBasisPoints: number = 500
  ): Promise<TradeResult> {
    try {
      const mint = new PublicKey(mintAddress);
      const bondingCurve = this.sdk.getBondingCurvePDA(mint);
      const associatedBondingCurve = await getAssociatedTokenAddress(mint, bondingCurve, true);
      const associatedUser = await getAssociatedTokenAddress(mint, seller.publicKey, false);

      const curveAccount = await this.sdk.getBondingCurveAccount(mint);
      if (!curveAccount) throw new Error("Bonding curve not found");

      const globalAccount = await this.sdk.getGlobalAccount();
      const sellAmount = BigInt(Math.round(tokenAmount * 1e6)); // 6 decimals
      const minSolOutput = curveAccount.getSellPrice(sellAmount, globalAccount.feeBasisPoints);
      const minSolWithSlippage = minSolOutput - (minSolOutput * BigInt(slippageBasisPoints) / 10000n);

      const tx = new Transaction();
      tx.add(ComputeBudgetProgram.setComputeUnitLimit({ units: 250000 }));
      tx.add(ComputeBudgetProgram.setComputeUnitPrice({ microLamports: 250000 }));

      // Encode sell instruction data
      const data = Buffer.alloc(8 + 8 + 8);
      SELL_DISCRIMINATOR.copy(data, 0);
      data.writeBigUInt64LE(sellAmount, 8);
      data.writeBigUInt64LE(minSolWithSlippage < 0n ? 0n : minSolWithSlippage, 16);

      const SYSVAR_RENT_SELL = new PublicKey("SysvarRent111111111111111111111111111111111");
      tx.add(new TransactionInstruction({
        programId: PUMP_PROGRAM_ID,
        keys: [
          { pubkey: PUMP_GLOBAL, isSigner: false, isWritable: false },
          { pubkey: globalAccount.feeRecipient, isSigner: false, isWritable: true },
          { pubkey: mint, isSigner: false, isWritable: false },
          { pubkey: bondingCurve, isSigner: false, isWritable: true },
          { pubkey: associatedBondingCurve, isSigner: false, isWritable: true },
          { pubkey: associatedUser, isSigner: false, isWritable: true },
          { pubkey: seller.publicKey, isSigner: true, isWritable: true },
          { pubkey: SystemProgram.programId, isSigner: false, isWritable: false },
          { pubkey: ASSOCIATED_TOKEN_PROGRAM_ID, isSigner: false, isWritable: false },
          { pubkey: TOKEN_PROGRAM_ID, isSigner: false, isWritable: false },
          { pubkey: SYSVAR_RENT_SELL, isSigner: false, isWritable: false },
          { pubkey: PUMP_EVENT_AUTHORITY, isSigner: false, isWritable: false },
          { pubkey: PUMP_PROGRAM_ID, isSigner: false, isWritable: false },
          // remaining accounts:
          { pubkey: GLOBAL_VOLUME_ACCUMULATOR, isSigner: false, isWritable: true },
        ],
        data,
      }));

      const sig = await sendAndConfirmTransaction(this.connection, tx, [seller], {
        commitment: "confirmed",
      });

      return {
        success: true,
        txSignature: sig,
        explorerUrl: `https://solscan.io/tx/${sig}`,
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
