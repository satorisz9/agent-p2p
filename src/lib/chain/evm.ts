/**
 * EVM On-Chain Client — ERC-20 Token operations.
 *
 * Supports any EVM-compatible chain:
 *   - Local (Ganache/Hardhat/Anvil) for testing
 *   - Base Sepolia for testnet
 *   - Base / Ethereum mainnet for production
 */

import { ethers } from "ethers";
import { readFileSync } from "fs";
import { join, dirname } from "path";
import { fileURLToPath } from "url";

export type EVMNetwork = "local" | "base-sepolia" | "base" | "ethereum";

export interface EVMConfig {
  network: EVMNetwork;
  rpcUrl?: string;
}

export interface DeployResult {
  contractAddress: string;
  txHash: string;
  explorerUrl: string;
}

export interface TxResult {
  txHash: string;
  explorerUrl: string;
}

// Load compiled contract (ABI + bytecode)
function loadCompiledContract(): { abi: any[]; bytecode: string } {
  // Try multiple resolution paths
  const candidates = [
    join(__dirname, "erc20-compiled.json"),
    join(process.cwd(), "src/lib/chain/erc20-compiled.json"),
  ];
  for (const p of candidates) {
    try {
      return JSON.parse(readFileSync(p, "utf8"));
    } catch {}
  }
  throw new Error("Cannot find erc20-compiled.json");
}

export class EVMClient {
  private provider: ethers.JsonRpcProvider;
  private network: EVMNetwork;
  private nonceCache = new Map<string, number>(); // address → next nonce

  constructor(config: EVMConfig) {
    this.network = config.network;
    const url = config.rpcUrl || this.defaultRpcUrl(config.network);
    this.provider = new ethers.JsonRpcProvider(url);
  }

  private defaultRpcUrl(network: EVMNetwork): string {
    switch (network) {
      case "local": return "http://127.0.0.1:8545";
      case "base-sepolia": return "https://sepolia.base.org";
      case "base": return "https://mainnet.base.org";
      case "ethereum": return "https://eth.llamarpc.com";
    }
  }

  getNetwork(): EVMNetwork { return this.network; }
  getProvider(): ethers.JsonRpcProvider { return this.provider; }

  /** Derive EVM wallet from Ed25519 private key (first 32 bytes). */
  walletFromPrivateKey(privateKeyBase64: string): ethers.Wallet {
    const raw = Buffer.from(privateKeyBase64, "base64");
    const evmKey = "0x" + raw.slice(0, 32).toString("hex");
    return new ethers.Wallet(evmKey, this.provider);
  }

  /** Get native balance (ETH) formatted. */
  async getBalance(address: string): Promise<string> {
    const bal = await this.provider.getBalance(address);
    return ethers.formatEther(bal);
  }

  /** Deploy a new ERC-20 token. Returns contract address. */
  async deployToken(
    wallet: ethers.Wallet,
    name: string,
    symbol: string,
    decimals: number,
    initialSupply: number
  ): Promise<DeployResult> {
    const { abi, bytecode } = loadCompiledContract();
    const factory = new ethers.ContractFactory(abi, bytecode, wallet);
    const rawSupply = ethers.parseUnits(String(initialSupply), decimals);
    const nonce = await this.nextNonce(wallet.address);
    const contract = await factory.deploy(name, symbol, decimals, rawSupply, { nonce });
    await contract.waitForDeployment();

    const address = await contract.getAddress();
    const txHash = contract.deploymentTransaction()?.hash || "";
    return {
      contractAddress: address,
      txHash,
      explorerUrl: this.explorerUrl("address", address),
    };
  }

  /** Get next nonce for an address. Tracks locally to avoid Ganache stale nonce issue. */
  private async nextNonce(address: string): Promise<number> {
    if (!this.nonceCache.has(address)) {
      const onChain = await this.provider.getTransactionCount(address, "latest");
      this.nonceCache.set(address, onChain);
    }
    const nonce = this.nonceCache.get(address)!;
    this.nonceCache.set(address, nonce + 1);
    return nonce;
  }

  /** Mint additional tokens (owner only). */
  async mintTokens(
    wallet: ethers.Wallet,
    contractAddress: string,
    to: string,
    amount: number,
    decimals: number
  ): Promise<TxResult> {
    const { abi } = loadCompiledContract();
    const contract = new ethers.Contract(contractAddress, abi, wallet);
    const rawAmount = ethers.parseUnits(String(amount), decimals);
    const nonce = await this.nextNonce(wallet.address);
    const tx = await contract.mint.send(to, rawAmount, { nonce });
    await tx.wait();
    return { txHash: tx.hash, explorerUrl: this.explorerUrl("tx", tx.hash) };
  }

  /** Transfer ERC-20 tokens. */
  async transferTokens(
    wallet: ethers.Wallet,
    contractAddress: string,
    to: string,
    amount: number,
    decimals: number
  ): Promise<TxResult> {
    const { abi } = loadCompiledContract();
    const contract = new ethers.Contract(contractAddress, abi, wallet);
    const rawAmount = ethers.parseUnits(String(amount), decimals);
    // Manually build, sign, and send (bypass ethers nonce caching)
    const data = contract.interface.encodeFunctionData("transfer", [to, rawAmount]);
    const nonce = await this.nextNonce(wallet.address);
    const feeData = await this.provider.getFeeData();
    const tx = await wallet.signTransaction({
      to: contractAddress,
      data,
      nonce,
      gasLimit: 100000n,
      maxFeePerGas: feeData.maxFeePerGas || feeData.gasPrice || 1000000000n,
      maxPriorityFeePerGas: feeData.maxPriorityFeePerGas || 1000000000n,
      chainId: (await this.provider.getNetwork()).chainId,
      type: 2,
    });
    const sentTx = await this.provider.broadcastTransaction(tx);
    await sentTx.wait();
    return { txHash: sentTx.hash, explorerUrl: this.explorerUrl("tx", sentTx.hash) };
  }

  /** Get ERC-20 token balance. */
  async getTokenBalance(
    contractAddress: string,
    ownerAddress: string
  ): Promise<{ amount: number; rawAmount: string; decimals: number }> {
    const { abi } = loadCompiledContract();
    const contract = new ethers.Contract(contractAddress, abi, this.provider);
    const [rawBal, dec] = await Promise.all([
      contract.balanceOf(ownerAddress),
      contract.decimals(),
    ]);
    const decimals = Number(dec);
    const amount = Number(ethers.formatUnits(rawBal, decimals));
    return { amount, rawAmount: rawBal.toString(), decimals };
  }

  /** Get ERC-20 token info. */
  async getTokenInfo(contractAddress: string): Promise<{
    name: string; symbol: string; decimals: number;
    totalSupply: string; owner: string;
  }> {
    const { abi } = loadCompiledContract();
    const contract = new ethers.Contract(contractAddress, abi, this.provider);
    const [name, symbol, decimals, totalSupply, owner] = await Promise.all([
      contract.name(), contract.symbol(), contract.decimals(),
      contract.totalSupply(), contract.owner(),
    ]);
    return {
      name, symbol,
      decimals: Number(decimals),
      totalSupply: totalSupply.toString(),
      owner,
    };
  }

  /** Generate block explorer URL. */
  explorerUrl(type: "tx" | "address", value: string): string {
    switch (this.network) {
      case "local": return `local://${type}/${value}`;
      case "base-sepolia": return `https://sepolia.basescan.org/${type}/${value}`;
      case "base": return `https://basescan.org/${type}/${value}`;
      case "ethereum": return `https://etherscan.io/${type}/${value}`;
    }
  }
}
