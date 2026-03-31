/**
 * E2E EVM On-Chain Tests (Ganache local node)
 *
 * Fully local — no faucet, no network, no rate limits.
 * Spins up Ganache in-process, deploys ERC-20, mints, transfers.
 */

import { describe, it, before, after } from "node:test";
import assert from "node:assert/strict";
import ganache from "ganache";
import { ethers } from "ethers";
import { EVMClient } from "../src/lib/chain/evm";
import { generateKeyPair, toBase64 } from "../src/lib/crypto/keys";

let server: ReturnType<typeof ganache.server>;
const PORT = 18545;

describe("EVM On-Chain E2E (Ganache)", () => {
  let evm: EVMClient;
  let aliceWallet: ethers.Wallet;
  let bobWallet: ethers.Wallet;
  let contractAddress: string;

  before(async () => {
    server = ganache.server({ wallet: { totalAccounts: 2 } });
    await server.listen(PORT);

    evm = new EVMClient({ network: "local", rpcUrl: `http://127.0.0.1:${PORT}` });

    // Derive wallets from Ed25519 keys (same as agent would)
    const aliceKeys = generateKeyPair();
    const bobKeys = generateKeyPair();
    const alicePrivB64 = toBase64(aliceKeys.privateKey);
    const bobPrivB64 = toBase64(bobKeys.privateKey);

    // Ganache pre-funds its own accounts — we need to use those
    const provider = evm.getProvider();
    const accounts = await provider.listAccounts();
    // Use Ganache's funded accounts directly
    const ganacheProvider = new ethers.JsonRpcProvider(`http://127.0.0.1:${PORT}`);
    // Get private keys from Ganache
    const ganacheAccounts = await ganacheProvider.send("eth_accounts", []);

    // For this test, derive wallets from agent keys and fund them from Ganache
    aliceWallet = evm.walletFromPrivateKey(alicePrivB64);
    bobWallet = evm.walletFromPrivateKey(bobPrivB64);

    // Fund Alice from Ganache account[0]
    const funderSigner = await provider.getSigner(0);
    const tx1 = await funderSigner.sendTransaction({
      to: aliceWallet.address,
      value: ethers.parseEther("10"),
    });
    await tx1.wait();

    // Fund Bob too (for gas)
    const tx2 = await funderSigner.sendTransaction({
      to: bobWallet.address,
      value: ethers.parseEther("5"),
    });
    await tx2.wait();
  });

  after(async () => {
    await server.close();
  });

  it("wallets have ETH balance", async () => {
    const aliceBal = await evm.getBalance(aliceWallet.address);
    const bobBal = await evm.getBalance(bobWallet.address);
    console.log(`  Alice: ${aliceWallet.address} (${aliceBal} ETH)`);
    console.log(`  Bob:   ${bobWallet.address} (${bobBal} ETH)`);
    assert.ok(parseFloat(aliceBal) >= 9, "Alice should have ~10 ETH");
    assert.ok(parseFloat(bobBal) >= 4, "Bob should have ~5 ETH");
  });

  it("deploy ERC-20 token", async () => {
    const result = await evm.deployToken(aliceWallet, "TestCoin", "TEST", 18, 1000000);
    assert.ok(result.contractAddress, "Should have contract address");
    assert.ok(result.txHash, "Should have tx hash");
    contractAddress = result.contractAddress;
    console.log(`  Contract: ${contractAddress}`);
    console.log(`  Deploy TX: ${result.txHash}`);
  });

  it("token info is correct", async () => {
    const info = await evm.getTokenInfo(contractAddress);
    assert.equal(info.name, "TestCoin");
    assert.equal(info.symbol, "TEST");
    assert.equal(info.decimals, 18);
    assert.equal(info.owner, aliceWallet.address);
    console.log(`  Supply: ${info.totalSupply}`);
  });

  it("initial balance correct", async () => {
    const bal = await evm.getTokenBalance(contractAddress, aliceWallet.address);
    assert.equal(bal.amount, 1000000);
    assert.equal(bal.decimals, 18);
    console.log(`  Alice: ${bal.amount} TEST`);
  });

  it("mint additional tokens", async () => {
    const result = await evm.mintTokens(
      aliceWallet, contractAddress, aliceWallet.address, 500000, 18
    );
    assert.ok(result.txHash);
    console.log(`  Mint TX: ${result.txHash}`);

    const bal = await evm.getTokenBalance(contractAddress, aliceWallet.address);
    assert.equal(bal.amount, 1500000, "1M + 500K = 1.5M");
  });

  it("transfer tokens to Bob", async () => {
    const result = await evm.transferTokens(
      aliceWallet, contractAddress, bobWallet.address, 250000, 18
    );
    assert.ok(result.txHash);
    console.log(`  Transfer TX: ${result.txHash}`);

    const aliceBal = await evm.getTokenBalance(contractAddress, aliceWallet.address);
    assert.equal(aliceBal.amount, 1250000, "Alice: 1.5M - 250K = 1.25M");

    const bobBal = await evm.getTokenBalance(contractAddress, bobWallet.address);
    assert.equal(bobBal.amount, 250000, "Bob: 250K");
    console.log(`  Alice: ${aliceBal.amount} TEST`);
    console.log(`  Bob:   ${bobBal.amount} TEST`);
  });

  it("Bob can transfer tokens too", async () => {
    const result = await evm.transferTokens(
      bobWallet, contractAddress, aliceWallet.address, 50000, 18
    );
    assert.ok(result.txHash);

    const bobBal = await evm.getTokenBalance(contractAddress, bobWallet.address);
    assert.equal(bobBal.amount, 200000, "Bob: 250K - 50K = 200K");
  });

  it("insufficient balance transfer reverts", async () => {
    await assert.rejects(
      () => evm.transferTokens(bobWallet, contractAddress, aliceWallet.address, 999999, 18),
      /Insufficient balance|revert/
    );
  });

  it("non-owner cannot mint", async () => {
    await assert.rejects(
      () => evm.mintTokens(bobWallet, contractAddress, bobWallet.address, 1000, 18),
      /Only owner|revert/
    );
  });

  it("multiple transfers accumulate correctly", async () => {
    for (const amount of [100, 200, 300]) {
      await evm.transferTokens(aliceWallet, contractAddress, bobWallet.address, amount, 18);
    }
    const bobBal = await evm.getTokenBalance(contractAddress, bobWallet.address);
    // Bob had 200K, received 100+200+300 = 600
    assert.equal(bobBal.amount, 200600, "Bob: 200K + 600 = 200,600");
  });

  it("explorer URLs format correctly", () => {
    const txUrl = evm.explorerUrl("tx", "0xabc123");
    assert.ok(txUrl.includes("tx/0xabc123"));

    // Test other networks
    const baseSepolia = new EVMClient({ network: "base-sepolia" });
    assert.ok(baseSepolia.explorerUrl("address", "0x123").includes("sepolia.basescan.org"));

    const mainnet = new EVMClient({ network: "base" });
    assert.ok(mainnet.explorerUrl("address", "0x123").includes("basescan.org"));
  });
});
