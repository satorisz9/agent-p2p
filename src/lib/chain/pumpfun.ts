/**
 * Pump.fun Integration — Launch & trade tokens on Solana via pump.fun
 *
 * Buy/sell built directly with the current program account layout (17 accounts).
 * The pumpdotfun-sdk is used only for launch (createAndBuy) and curve queries.
 */

import {
  Connection, Keypair, PublicKey, clusterApiUrl, LAMPORTS_PER_SOL,
  Transaction, TransactionInstruction, SystemProgram,
  sendAndConfirmTransaction, ComputeBudgetProgram,
} from "@solana/web3.js";
import {
  getAssociatedTokenAddress, createAssociatedTokenAccountInstruction,
  getAccount, TOKEN_PROGRAM_ID,
} from "@solana/spl-token";
import { AnchorProvider, Wallet } from "@coral-xyz/anchor";
import { PumpFunSDK } from "pumpdotfun-sdk";
import type { CreateTokenMetadata, TransactionResult, PriorityFee } from "pumpdotfun-sdk";

// --- Constants ---
const PUMP_PROGRAM = new PublicKey("6EF8rrecthR5Dkzon8Nwu78hRvfCKubJ14M5uBEwF6P");
const PUMP_GLOBAL = new PublicKey("4wTV1YmiEkRvAtNtsSGPtUrqRYQMe5SKy2uB4Jjaxnjf");
const PUMP_EVENT_AUTHORITY = PublicKey.findProgramAddressSync([Buffer.from("__event_authority")], PUMP_PROGRAM)[0];
const GLOBAL_VOLUME_ACCUMULATOR = PublicKey.findProgramAddressSync([Buffer.from("global_volume_accumulator")], PUMP_PROGRAM)[0];
const FEE_PROGRAM = new PublicKey("pfeeUxB6jkeY1Hxd7CsFCAjcbHA9rWtchMGdZ6VojVZ");
const FEE_CONFIG = PublicKey.findProgramAddressSync([Buffer.from("fee_config"), PUMP_PROGRAM.toBytes()], FEE_PROGRAM)[0];

const BUY_DISCRIMINATOR = Buffer.from([102, 6, 61, 18, 1, 218, 235, 234]);
const SELL_DISCRIMINATOR = Buffer.from([51, 230, 133, 164, 1, 127, 131, 173]);

function deriveBondingCurve(mint: PublicKey): PublicKey {
  return PublicKey.findProgramAddressSync([Buffer.from("bonding-curve"), mint.toBytes()], PUMP_PROGRAM)[0];
}
function deriveBondingCurveV2(mint: PublicKey): PublicKey {
  return PublicKey.findProgramAddressSync([Buffer.from("bonding-curve-v2"), mint.toBytes()], PUMP_PROGRAM)[0];
}
function deriveCreatorVault(creator: PublicKey): PublicKey {
  return PublicKey.findProgramAddressSync([Buffer.from("creator-vault"), creator.toBytes()], PUMP_PROGRAM)[0];
}
function deriveUserVolumeAccumulator(user: PublicKey): PublicKey {
  return PublicKey.findProgramAddressSync([Buffer.from("user_volume_accumulator"), user.toBytes()], PUMP_PROGRAM)[0];
}

export interface PumpFunConfig { rpcUrl?: string; }
export interface LaunchResult { success: boolean; mintAddress?: string; txSignature?: string; bondingCurveAddress?: string; explorerUrl?: string; pumpFunUrl?: string; error?: string; }
export interface TradeResult { success: boolean; txSignature?: string; explorerUrl?: string; error?: string; }

export class PumpFunClient {
  private connection: Connection;
  private sdk: PumpFunSDK;

  constructor(config: PumpFunConfig = {}) {
    const url = config.rpcUrl || clusterApiUrl("mainnet-beta");
    this.connection = new Connection(url, "confirmed");
    const provider = new AnchorProvider(this.connection, new Wallet(Keypair.generate()), { commitment: "confirmed" });
    this.sdk = new PumpFunSDK(provider);
  }

  async launch(
    creator: Keypair, name: string, symbol: string, description: string,
    imageBuffer: Buffer, imageName = "token.png", initialBuySol = 0,
    options: { twitter?: string; telegram?: string; website?: string; priorityFees?: PriorityFee; slippageBasisPoints?: number } = {}
  ): Promise<LaunchResult> {
    try {
      const mint = Keypair.generate();
      const metadata: CreateTokenMetadata = {
        name, symbol, description,
        file: new Blob([new Uint8Array(imageBuffer)], { type: "image/png" }),
        twitter: options.twitter, telegram: options.telegram, website: options.website,
      };
      const result: TransactionResult = await this.sdk.createAndBuy(
        creator, mint, metadata,
        BigInt(Math.round(initialBuySol * LAMPORTS_PER_SOL)),
        BigInt(options.slippageBasisPoints || 500),
        options.priorityFees || { unitLimit: 250000, unitPrice: 250000 },
        "confirmed", "confirmed"
      );
      if (!result.success) return { success: false, error: result.error ? String(result.error) : "Failed" };
      const mintAddress = mint.publicKey.toBase58();
      return {
        success: true, mintAddress, txSignature: result.signature,
        bondingCurveAddress: deriveBondingCurve(mint.publicKey).toBase58(),
        explorerUrl: `https://solscan.io/tx/${result.signature}`,
        pumpFunUrl: `https://pump.fun/coin/${mintAddress}`,
      };
    } catch (err: any) { return { success: false, error: err.message }; }
  }

  /**
   * Buy tokens — 17 account layout (Feb 2026 program update).
   */
  async buy(buyer: Keypair, mintAddress: string, solAmount: number, slippageBasisPoints = 500): Promise<TradeResult> {
    try {
      const mint = new PublicKey(mintAddress);
      const bondingCurve = deriveBondingCurve(mint);
      const bondingCurveV2 = deriveBondingCurveV2(mint);
      const associatedBondingCurve = await getAssociatedTokenAddress(mint, bondingCurve, true);
      const associatedUser = await getAssociatedTokenAddress(mint, buyer.publicKey, false);

      // Read bonding curve to get creator + price
      const curveData = await this.connection.getAccountInfo(bondingCurve);
      if (!curveData) throw new Error("Bonding curve not found");
      const creator = new PublicKey(curveData.data.subarray(49, 81));
      const creatorVault = deriveCreatorVault(creator);

      const curveAccount = await this.sdk.getBondingCurveAccount(mint);
      if (!curveAccount) throw new Error("Cannot parse bonding curve");
      const globalAccount = await this.sdk.getGlobalAccount();

      const buyAmountSol = BigInt(Math.round(solAmount * LAMPORTS_PER_SOL));
      const buyAmount = curveAccount.getBuyPrice(buyAmountSol);
      const maxSolCost = buyAmountSol + (buyAmountSol * BigInt(slippageBasisPoints) / 10000n);

      const tx = new Transaction();
      tx.add(ComputeBudgetProgram.setComputeUnitLimit({ units: 300000 }));
      tx.add(ComputeBudgetProgram.setComputeUnitPrice({ microLamports: 500000 }));

      // Create ATA if needed
      try { await getAccount(this.connection, associatedUser); }
      catch { tx.add(createAssociatedTokenAccountInstruction(buyer.publicKey, associatedUser, buyer.publicKey, mint)); }

      // Buy data: discriminator(8) + amount(8) + maxSolCost(8)
      const data = Buffer.alloc(24);
      BUY_DISCRIMINATOR.copy(data, 0);
      data.writeBigUInt64LE(buyAmount, 8);
      data.writeBigUInt64LE(maxSolCost, 16);

      tx.add(new TransactionInstruction({
        programId: PUMP_PROGRAM,
        keys: [
          { pubkey: PUMP_GLOBAL, isSigner: false, isWritable: false },                  // 0
          { pubkey: globalAccount.feeRecipient, isSigner: false, isWritable: true },     // 1
          { pubkey: mint, isSigner: false, isWritable: false },                          // 2
          { pubkey: bondingCurve, isSigner: false, isWritable: true },                   // 3
          { pubkey: associatedBondingCurve, isSigner: false, isWritable: true },         // 4
          { pubkey: associatedUser, isSigner: false, isWritable: true },                 // 5
          { pubkey: buyer.publicKey, isSigner: true, isWritable: true },                 // 6
          { pubkey: SystemProgram.programId, isSigner: false, isWritable: false },       // 7
          { pubkey: TOKEN_PROGRAM_ID, isSigner: false, isWritable: false },              // 8
          { pubkey: creatorVault, isSigner: false, isWritable: true },                   // 9
          { pubkey: PUMP_EVENT_AUTHORITY, isSigner: false, isWritable: false },          // 10
          { pubkey: PUMP_PROGRAM, isSigner: false, isWritable: false },                  // 11
          { pubkey: GLOBAL_VOLUME_ACCUMULATOR, isSigner: false, isWritable: false },     // 12
          { pubkey: deriveUserVolumeAccumulator(buyer.publicKey), isSigner: false, isWritable: true }, // 13
          { pubkey: FEE_CONFIG, isSigner: false, isWritable: false },                    // 14
          { pubkey: FEE_PROGRAM, isSigner: false, isWritable: false },                   // 15
          { pubkey: bondingCurveV2, isSigner: false, isWritable: false },                // 16 (remaining)
        ],
        data,
      }));

      const sig = await sendAndConfirmTransaction(this.connection, tx, [buyer], { commitment: "confirmed" });
      return { success: true, txSignature: sig, explorerUrl: `https://solscan.io/tx/${sig}` };
    } catch (err: any) { return { success: false, error: err.message }; }
  }

  /**
   * Sell tokens — 15-16 account layout.
   */
  async sell(seller: Keypair, mintAddress: string, tokenAmount: number, slippageBasisPoints = 500): Promise<TradeResult> {
    try {
      const mint = new PublicKey(mintAddress);
      const bondingCurve = deriveBondingCurve(mint);
      const bondingCurveV2 = deriveBondingCurveV2(mint);
      const associatedBondingCurve = await getAssociatedTokenAddress(mint, bondingCurve, true);
      const associatedUser = await getAssociatedTokenAddress(mint, seller.publicKey, false);

      const curveData = await this.connection.getAccountInfo(bondingCurve);
      if (!curveData) throw new Error("Bonding curve not found");
      const creator = new PublicKey(curveData.data.subarray(49, 81));
      const creatorVault = deriveCreatorVault(creator);

      const curveAccount = await this.sdk.getBondingCurveAccount(mint);
      if (!curveAccount) throw new Error("Cannot parse bonding curve");
      const globalAccount = await this.sdk.getGlobalAccount();

      const sellAmount = BigInt(Math.round(tokenAmount * 1e6));
      const minSolOutput = curveAccount.getSellPrice(sellAmount, globalAccount.feeBasisPoints);
      const minWithSlippage = minSolOutput - (minSolOutput * BigInt(slippageBasisPoints) / 10000n);

      const tx = new Transaction();
      tx.add(ComputeBudgetProgram.setComputeUnitLimit({ units: 300000 }));
      tx.add(ComputeBudgetProgram.setComputeUnitPrice({ microLamports: 500000 }));

      const data = Buffer.alloc(24);
      SELL_DISCRIMINATOR.copy(data, 0);
      data.writeBigUInt64LE(sellAmount, 8);
      data.writeBigUInt64LE(minWithSlippage < 0n ? 0n : minWithSlippage, 16);

      tx.add(new TransactionInstruction({
        programId: PUMP_PROGRAM,
        keys: [
          { pubkey: PUMP_GLOBAL, isSigner: false, isWritable: false },
          { pubkey: globalAccount.feeRecipient, isSigner: false, isWritable: true },
          { pubkey: mint, isSigner: false, isWritable: false },
          { pubkey: bondingCurve, isSigner: false, isWritable: true },
          { pubkey: associatedBondingCurve, isSigner: false, isWritable: true },
          { pubkey: associatedUser, isSigner: false, isWritable: true },
          { pubkey: seller.publicKey, isSigner: true, isWritable: true },
          { pubkey: SystemProgram.programId, isSigner: false, isWritable: false },
          { pubkey: TOKEN_PROGRAM_ID, isSigner: false, isWritable: false },
          { pubkey: creatorVault, isSigner: false, isWritable: true },
          { pubkey: PUMP_EVENT_AUTHORITY, isSigner: false, isWritable: false },
          { pubkey: PUMP_PROGRAM, isSigner: false, isWritable: false },
          { pubkey: FEE_CONFIG, isSigner: false, isWritable: false },
          { pubkey: FEE_PROGRAM, isSigner: false, isWritable: false },
          // remaining accounts:
          { pubkey: bondingCurveV2, isSigner: false, isWritable: false },
        ],
        data,
      }));

      const sig = await sendAndConfirmTransaction(this.connection, tx, [seller], { commitment: "confirmed" });
      return { success: true, txSignature: sig, explorerUrl: `https://solscan.io/tx/${sig}` };
    } catch (err: any) { return { success: false, error: err.message }; }
  }

  async getBondingCurve(mintAddress: string): Promise<{
    exists: boolean; virtualSolReserves?: string; virtualTokenReserves?: string;
    realSolReserves?: string; realTokenReserves?: string; complete?: boolean;
  }> {
    try {
      const curve = await this.sdk.getBondingCurveAccount(new PublicKey(mintAddress));
      if (!curve) return { exists: false };
      return {
        exists: true,
        virtualSolReserves: curve.virtualSolReserves.toString(),
        virtualTokenReserves: curve.virtualTokenReserves.toString(),
        realSolReserves: curve.realSolReserves.toString(),
        realTokenReserves: curve.realTokenReserves.toString(),
        complete: curve.complete,
      };
    } catch { return { exists: false }; }
  }
}
