/* global artifacts */

const ethers = require("ethers");
const chai = require("chai");
const BN = require("bn.js");
const bnChai = require("bn-chai");

const { assert } = chai;
const { expect } = chai;
chai.use(bnChai(BN));

const Proxy = artifacts.require("Proxy");
const BaseWallet = artifacts.require("BaseWallet");
const Registry = artifacts.require("ModuleRegistry");
const TransferStorage = artifacts.require("TransferStorage");
const GuardianStorage = artifacts.require("GuardianStorage");
const LimitStorage = artifacts.require("LimitStorage");
const TokenPriceStorage = artifacts.require("TokenPriceStorage");
const RelayerModule = artifacts.require("RelayerModule");
const TransferModule = artifacts.require("TransferManager");
const LegacyTransferManager = require("../build-legacy/v1.6.0/TransferManager");
const LegacyTokenPriceProvider = require("../build-legacy/v1.6.0/TokenPriceProvider");

const ERC20 = artifacts.require("TestERC20");
const WETH = artifacts.require("WETH9");
const TestContract = artifacts.require("TestContract");

const utils = require("../utils/utilities.js");
const { ETH_TOKEN, increaseTime } = require("../utils/utilities.js");

const ETH_LIMIT = 1000000;
const SECURITY_PERIOD = 2;
const SECURITY_WINDOW = 2;
const ZERO_BYTES32 = ethers.constants.HashZero;

const ACTION_TRANSFER = 0;

const RelayManager = require("../utils/relay-manager");

contract("TransferManager", (accounts) => {
  const manager = new RelayManager();

  const infrastructure = accounts[0];
  const owner = accounts[1];
  const nonowner = accounts[2];
  const recipient = accounts[3];
  const spender = accounts[4];

  let registry;
  let priceProvider;
  let transferStorage;
  let guardianStorage;
  let limitStorage;
  let tokenPriceStorage;
  let transferModule;
  let previousTransferModule;
  let wallet;
  let walletImplementation;
  let erc20;
  let weth;
  let relayerModule;

  before(async () => {
    weth = await WETH.new();
    registry = await Registry.new();
    priceProvider = await LegacyTokenPriceProvider.new(ethers.constants.AddressZero);
    await priceProvider.addManager(infrastructure);

    transferStorage = await TransferStorage.new();
    guardianStorage = await GuardianStorage.new();
    limitStorage = await LimitStorage.new();
    tokenPriceStorage = await TokenPriceStorage.new();
    await tokenPriceStorage.addManager(infrastructure);

    previousTransferModule = await LegacyTransferManager.new(
      registry.address,
      transferStorage.address,
      guardianStorage.address,
      priceProvider.address,
      SECURITY_PERIOD,
      SECURITY_WINDOW,
      ETH_LIMIT,
      ethers.constants.AddressZero,
    );

    transferModule = await TransferModule.new(
      registry.address,
      transferStorage.address,
      guardianStorage.address,
      limitStorage.address,
      tokenPriceStorage.address,
      SECURITY_PERIOD,
      SECURITY_WINDOW,
      ETH_LIMIT,
      weth.address,
      previousTransferModule.address,
    );

    await registry.registerModule(transferModule.address, ethers.utils.formatBytes32String("TransferModule"));

    walletImplementation = await BaseWallet.new();

    relayerModule = await RelayerModule.new(
      registry.address,
      guardianStorage.address,
      limitStorage.address,
      tokenPriceStorage.address,
    );
    manager.setRelayerModule(relayerModule);
  });

  beforeEach(async () => {
    const proxy = await Proxy.new(walletImplementation.address);
    wallet = await BaseWallet.at(proxy.address);
    await wallet.init(owner, [transferModule.address, relayerModule.address]);

    const decimals = 12; // number of decimal for TOKN contract
    const tokenRate = new BN(10).pow(new BN(19)).muln(51); // 1 TOKN = 0.00051 ETH = 0.00051*10^18 ETH wei => *10^(18-decimals) = 0.00051*10^18 * 10^6 = 0.00051*10^24 = 51*10^19

    erc20 = await ERC20.new([infrastructure, wallet.address], 10000000, decimals); // TOKN contract with 10M tokens (5M TOKN for wallet and 5M TOKN for account[0])
    await tokenPriceStorage.setPrice(erc20.address, tokenRate.toString());
    await wallet.send(ethers.BigNumber.from("1000000000000000000"));
  });

  async function getEtherValue(amount, token) {
    if (token === ETH_TOKEN) {
      return amount;
    }
    const price = await tokenPriceStorage.getTokenPrice(token);
    const ethPrice = new BN(price.toString()).mul(new BN(amount)).div(new BN(10).pow(new BN(18)));
    return ethPrice;
  }

  describe("Initialising the module", () => {
    it("when no previous transfer manager is passed, should initialise with default limit", async () => {
      const transferModule1 = await TransferModule.new(
        registry.address,
        transferStorage.address,
        guardianStorage.address,
        limitStorage.address,
        tokenPriceStorage.address,
        SECURITY_PERIOD,
        SECURITY_WINDOW,
        10,
        ethers.constants.AddressZero,
        ethers.constants.AddressZero,
      );

      const proxy = await Proxy.new(walletImplementation.address);
      const existingWallet = await BaseWallet.at(proxy.address);
      await existingWallet.init(owner, [transferModule1.address]);

      const defautlimit = await transferModule1.defaultLimit();
      const limit = await transferModule1.getCurrentLimit(existingWallet.address);
      assert.equal(limit.toNumber(), defautlimit.toNumber());
    });
  });

  describe("Managing the whitelist", () => {
    it("should add/remove an account to/from the whitelist", async () => {
      await transferModule.addToWhitelist(wallet.address, recipient, { from: owner });
      let isTrusted = await transferModule.isWhitelisted(wallet.address, recipient);
      assert.equal(isTrusted, false, "should not be trusted during the security period");
      await increaseTime(3);
      isTrusted = await transferModule.isWhitelisted(wallet.address, recipient);
      assert.equal(isTrusted, true, "should be trusted after the security period");
      await transferModule.removeFromWhitelist(wallet.address, recipient, { from: owner });
      isTrusted = await transferModule.isWhitelisted(wallet.address, recipient);
      assert.equal(isTrusted, false, "should no removed from whitelist immediately");
    });

    it("should not be able to whitelist a token twice", async () => {
      await transferModule.addToWhitelist(wallet.address, recipient, { from: owner });
      await increaseTime(3);
      await utils.assertRevert(transferModule.addToWhitelist(wallet.address, recipient, { from: owner }), "TT: target already whitelisted");
    });

    it("should not be able to remove a non-whitelisted token from the whitelist", async () => {
      await utils.assertRevert(transferModule.removeFromWhitelist(wallet.address, recipient, { from: owner }),
        "TT: target not whitelisted");
    });
  });

  describe("Reading and writing token prices", () => {
    let erc20First;
    let erc20Second;
    let erc20ZeroDecimals;

    beforeEach(async () => {
      erc20First = await ERC20.new([infrastructure], 10000000, 18);
      erc20Second = await ERC20.new([infrastructure], 10000000, 18);
      erc20ZeroDecimals = await ERC20.new([infrastructure], 10000000, 0);
    });

    it("should get a token price correctly", async () => {
      const tokenPrice = new BN(10).pow(new BN(18)).muln(1800);
      await tokenPriceStorage.setPrice(erc20First.address, tokenPrice.toString());
      const tokenPriceSet = await tokenPriceStorage.getTokenPrice(erc20First.address);
      expect(tokenPrice).to.eq.BN(tokenPriceSet.toString());
    });

    it("should get multiple token prices correctly", async () => {
      await tokenPriceStorage.setPriceForTokenList([erc20First.address, erc20Second.address], [1800, 1900]);
      const tokenPricesSet = await tokenPriceStorage.getPriceForTokenList([erc20First.address, erc20Second.address]);
      expect(1800).to.eq.BN(tokenPricesSet[0].toString());
      expect(1900).to.eq.BN(tokenPricesSet[1].toString());
    });

    it("should set token price correctly", async () => {
      const tokenPrice = new BN(10).pow(new BN(18)).muln(1800);
      await tokenPriceStorage.setPrice(erc20First.address, tokenPrice.toString());
      const tokenPriceSet = await tokenPriceStorage.cachedPrices(erc20First.address);
      expect(tokenPrice).to.eq.BN(tokenPriceSet.toString());
    });

    it("should set multiple token prices correctly", async () => {
      await tokenPriceStorage.setPriceForTokenList([erc20First.address, erc20Second.address], [1800, 1900]);
      const tokenPrice1Set = await tokenPriceStorage.cachedPrices(erc20First.address);
      expect(1800).to.eq.BN(tokenPrice1Set.toString());
      const tokenPrice2Set = await tokenPriceStorage.cachedPrices(erc20Second.address);
      expect(1900).to.eq.BN(tokenPrice2Set.toString());
    });

    it("should be able to get the ether value of a given amount of tokens", async () => {
      const tokenPrice = new BN(10).pow(new BN(18)).muln(1800);
      await tokenPriceStorage.setPrice(erc20First.address, tokenPrice.toString());
      const etherValue = await getEtherValue("15000000000000000000", erc20First.address);
      // expectedValue = 1800*10^18/10^18 (price for 1 token wei) * 15*10^18 (amount) = 1800 * 15*10^18 = 27,000 * 10^18
      const expectedValue = new BN(10).pow(new BN(18)).muln(27000);
      expect(expectedValue).to.eq.BN(etherValue);
    });

    it("should be able to get the ether value for a token with 0 decimals", async () => {
      const tokenPrice = new BN(10).pow(new BN(36)).muln(23000);
      await tokenPriceStorage.setPrice(erc20ZeroDecimals.address, tokenPrice.toString());
      const etherValue = await getEtherValue(100, erc20ZeroDecimals.address);
      // expectedValue = 23000*10^36 * 100 / 10^18 = 2,300,000 * 10^18
      const expectedValue = new BN(10).pow(new BN(18)).muln(2300000);
      expect(expectedValue).to.eq.BN(etherValue);
    });

    it("should return 0 as the ether value for a low priced token", async () => {
      await tokenPriceStorage.setPrice(erc20First.address, 23000);
      const etherValue = await getEtherValue(100, erc20First.address);
      assert.equal(etherValue.toString(), 0); // 2,300,000
    });
  });

  describe("Daily limit", () => {
    it("should migrate the limit for existing wallets", async () => {
      // create wallet with previous module and funds
      const proxy = await Proxy.new(walletImplementation.address);
      const existingWallet = await BaseWallet.at(proxy.address);

      await existingWallet.init(owner.address, [previousTransferModule.address]);
      await existingWallet.send(ethers.BigNumber.from("100000000"));
      // change the limit
      await previousTransferModule.changeLimit(existingWallet.address, 4000000, { from: owner });
      await increaseTime(SECURITY_PERIOD + 1);
      let limit = await previousTransferModule.getCurrentLimit(existingWallet.address);
      assert.equal(limit.toNumber(), 4000000, "limit should be changed");
      // transfer some funds
      await previousTransferModule.transferToken(existingWallet.address, ETH_TOKEN, recipient, 1000000, ZERO_BYTES32, { from: owner });
      // add new module
      await previousTransferModule.addModule(existingWallet.address, transferModule.address, { from: owner });
      // check result
      limit = await transferModule.getCurrentLimit(existingWallet.address);
      assert.equal(limit.toNumber(), 4000000, "limit should have been migrated");
      const unspent = await transferModule.getDailyUnspent(existingWallet.address);
      assert.equal(unspent[0].toNumber(), 4000000 - 1000000, "unspent should have been migrated");
    });

    it("should set the default limit for new wallets", async () => {
      const limit = await transferModule.getCurrentLimit(wallet.address);
      assert.equal(limit.toNumber(), ETH_LIMIT, "limit should be ETH_LIMIT");
    });

    it("should only increase the limit after the security period", async () => {
      await transferModule.changeLimit(wallet.address, 4000000, { from: owner });
      let limit = await transferModule.getCurrentLimit(wallet.address);
      assert.equal(limit.toNumber(), ETH_LIMIT, "limit should be ETH_LIMIT");
      await increaseTime(SECURITY_PERIOD + 1);
      limit = await transferModule.getCurrentLimit(wallet.address);
      assert.equal(limit.toNumber(), 4000000, "limit should be changed");
    });

    it("should decrease the limit immediately", async () => {
      let limit = await transferModule.getCurrentLimit(wallet.address);
      assert.equal(limit.toNumber(), ETH_LIMIT, "limit should be ETH_LIMIT");
      await transferModule.changeLimit(wallet.address, ETH_LIMIT / 2, { from: owner });
      limit = await transferModule.getCurrentLimit(wallet.address);
      assert.equal(limit.toNumber(), ETH_LIMIT / 2, "limit should be decreased immediately");
    });

    it("should change the limit via relayed transaction", async () => {
      await manager.relay(transferModule, "changeLimit", [wallet.address, 4000000], wallet, [owner]);
      await increaseTime(SECURITY_PERIOD + 1);
      const limit = await transferModule.getCurrentLimit(wallet.address);
      assert.equal(limit.toNumber(), 4000000, "limit should be changed");
    });

    it("should correctly set the pending limit", async () => {
      const tx = await transferModule.changeLimit(wallet.address, 4000000, { from: owner });
      const txReceipt = await transferModule.verboseWaitForTransaction(tx);
      const timestamp = await manager.getTimestamp(txReceipt.block);
      const { _pendingLimit, _changeAfter } = await transferModule.getPendingLimit(wallet.address);
      assert.equal(_pendingLimit.toNumber(), 4000000);
      assert.closeTo(_changeAfter.toNumber(), timestamp + SECURITY_PERIOD, 1); // timestamp is sometimes off by 1
    });

    it("should be able to disable the limit", async () => {
      await transferModule.disableLimit(wallet.address, { from: owner });
      let limitDisabled = await transferModule.isLimitDisabled(wallet.address);
      assert.isFalse(limitDisabled);
      await increaseTime(SECURITY_PERIOD + 1);
      limitDisabled = await transferModule.isLimitDisabled(wallet.address);
      assert.isTrue(limitDisabled);
    });

    it("should return the correct unspent daily limit amount", async () => {
      await wallet.send(ethers.BigNumber.from(ETH_LIMIT));
      const transferAmount = ETH_LIMIT - 100;
      await transferModule.transferToken(wallet.address, ETH_TOKEN, recipient, transferAmount, ZERO_BYTES32, { from: owner });
      const { _unspent } = await transferModule.getDailyUnspent(wallet.address);
      assert.equal(_unspent.toNumber(), 100);
    });

    it("should return the correct spent daily limit amount", async () => {
      await wallet.send(ethers.BigNumber.from(ETH_LIMIT));
      // Transfer 100 wei
      const tx = await transferModule.transferToken(wallet.address, ETH_TOKEN, recipient, 100, ZERO_BYTES32, { from: owner });
      const txReceipt = await transferModule.verboseWaitForTransaction(tx);
      const timestamp = await manager.getTimestamp(txReceipt.block);
      // Then transfer 200 wei more
      await transferModule.transferToken(wallet.address, ETH_TOKEN, recipient, 200, ZERO_BYTES32, { from: owner });

      const dailySpent = await limitStorage.getDailySpent(wallet.address);
      assert.equal(dailySpent[0].toNumber(), 300);
      assert.closeTo(dailySpent[1].toNumber(), timestamp + (3600 * 24), 1); // timestamp is sometimes off by 1
    });

    it("should return 0 if the entire daily limit amount has been spent", async () => {
      await wallet.send(ethers.BigNumber.from(ETH_LIMIT));
      await transferModule.transferToken(wallet.address, ETH_TOKEN, recipient, ETH_LIMIT, ZERO_BYTES32, { from: owner });
      const { _unspent } = await transferModule.getDailyUnspent(wallet.address);
      assert.equal(_unspent.toNumber(), 0);
    });
  });

  describe("Token transfers", () => {
    async function doDirectTransfer({
      token, signer = owner, to, amount, relayed = false,
    }) {
      const fundsBefore = (token === ETH_TOKEN ? await to.getBalance() : await token.balanceOf(to.address));
      const unspentBefore = await transferModule.getDailyUnspent(wallet.address);
      const params = [wallet.address, token === ETH_TOKEN ? ETH_TOKEN : token.address, to.address, amount, ZERO_BYTES32];
      let txReceipt;
      if (relayed) {
        txReceipt = await manager.relay(transferModule, "transferToken", params, wallet, [signer]);
      } else {
        const tx = await transferModule.transferToken(...params, { from: signer });
        txReceipt = await transferModule.verboseWaitForTransaction(tx);
      }
      assert.isTrue(await utils.hasEvent(txReceipt, transferModule, "Transfer"), "should have generated Transfer event");
      const fundsAfter = (token === ETH_TOKEN ? await to.getBalance() : await token.balanceOf(to.address));
      const unspentAfter = await transferModule.getDailyUnspent(wallet.address);
      assert.equal(fundsAfter.sub(fundsBefore).toNumber(), amount, "should have transfered amount");
      const ethValue = (token === ETH_TOKEN ? amount : (await getEtherValue(amount, token.address)).toNumber());
      if (ethValue < ETH_LIMIT) {
        assert.equal(unspentBefore[0].sub(unspentAfter[0]).toNumber(), ethValue, "should have updated the daily spent in ETH");
      }
      return txReceipt;
    }

    async function doPendingTransfer({
      token, to, amount, delay, relayed = false,
    }) {
      const tokenAddress = token === ETH_TOKEN ? ETH_TOKEN : token.address;
      const fundsBefore = (token === ETH_TOKEN ? await utils.getBalance(to.address) : await token.balanceOf(to.address));
      const params = [wallet.address, tokenAddress, to.address, amount, ZERO_BYTES32];
      let txReceipt; let
        tx;
      if (relayed) {
        txReceipt = await manager.relay(transferModule, "transferToken", params, wallet, [owner]);
      } else {
        tx = await transferModule.transferToken(...params, { from: owner });
        txReceipt = await transferModule.verboseWaitForTransaction(tx);
      }
      assert.isTrue(await utils.hasEvent(txReceipt, transferModule, "PendingTransferCreated"), "should have generated PendingTransferCreated event");
      let fundsAfter = (token === ETH_TOKEN ? await utils.getBalance(to.address) : await token.balanceOf(to.address));
      assert.equal(fundsAfter.sub(fundsBefore).toNumber(), 0, "should not have transfered amount");
      if (delay === 0) {
        const id = ethers.utils.solidityKeccak256(["uint8", "address", "address", "uint256", "bytes", "uint256"],
          [ACTION_TRANSFER, tokenAddress, recipient, amount, ZERO_BYTES32, txReceipt.blockNumber]);
        return id;
      }
      await increaseTime(delay);
      tx = await transferModule.executePendingTransfer(wallet.address,
        tokenAddress, recipient, amount, ZERO_BYTES32, txReceipt.blockNumber);
      txReceipt = await transferModule.verboseWaitForTransaction(tx);
      assert.isTrue(await utils.hasEvent(txReceipt, transferModule, "PendingTransferExecuted"),
        "should have generated PendingTransferExecuted event");
      fundsAfter = (token === ETH_TOKEN ? await utils.getBalance(to.address) : await token.balanceOf(to.address));
      return assert.equal(fundsAfter.sub(fundsBefore).toNumber(), amount, "should have transfered amount");
    }

    describe("Small token transfers", () => {
      it("should let the owner send ETH", async () => {
        await doDirectTransfer({ token: ETH_TOKEN, to: recipient, amount: 10000 });
      });

      it("should let the owner send ETH (relayed)", async () => {
        await doDirectTransfer({
          token: ETH_TOKEN, to: recipient, amount: 10000, relayed: true,
        });
      });

      it("should let the owner send ERC20", async () => {
        await doDirectTransfer({ token: erc20, to: recipient, amount: 10 });
      });

      it("should let the owner send ERC20 (relayed)", async () => {
        await doDirectTransfer({
          token: erc20, to: recipient, amount: 10, relayed: true,
        });
      });

      it("should only let the owner send ETH", async () => {
        try {
          await doDirectTransfer({
            token: ETH_TOKEN, signer: nonowner, to: recipient, amount: 10000,
          });
          assert.fail("transfer should have failed");
        } catch (error) {
          assert.equal(error, "BM: must be owner or module");
        }
      });

      it("should calculate the daily unspent when the owner send ETH", async () => {
        let unspent = await transferModule.getDailyUnspent(wallet.address);
        assert.equal(unspent[0].toNumber(), ETH_LIMIT, "unspent should be the limit at the beginning of a period");
        await doDirectTransfer({ token: ETH_TOKEN, to: recipient, amount: 10000 });
        unspent = await transferModule.getDailyUnspent(wallet.address);
        assert.equal(unspent[0].toNumber(), ETH_LIMIT - 10000, "should be the limit minus the transfer");
      });

      it("should calculate the daily unspent in ETH when the owner send ERC20", async () => {
        let unspent = await transferModule.getDailyUnspent(wallet.address);
        assert.equal(unspent[0].toNumber(), ETH_LIMIT, "unspent should be the limit at the beginning of a period");
        await doDirectTransfer({ token: erc20, to: recipient, amount: 10 });
        unspent = await transferModule.getDailyUnspent(wallet.address);
        const ethValue = await getEtherValue(10, erc20.address);
        assert.equal(unspent[0].toNumber(), ETH_LIMIT - ethValue.toNumber(), "should be the limit minus the transfer");
      });
    });

    describe("Large token transfers ", () => {
      it("should create and execute a pending ETH transfer", async () => {
        await doPendingTransfer({
          token: ETH_TOKEN, to: recipient, amount: ETH_LIMIT * 2, delay: 3, relayed: false,
        });
      });

      it("should create and execute a pending ETH transfer (relayed)", async () => {
        await doPendingTransfer({
          token: ETH_TOKEN, to: recipient, amount: ETH_LIMIT * 2, delay: 3, relayed: true,
        });
      });

      it("should create and execute a pending ERC20 transfer", async () => {
        await doPendingTransfer({
          token: erc20, to: recipient, amount: ETH_LIMIT * 2, delay: 3, relayed: false,
        });
      });

      it("should create and execute a pending ERC20 transfer (relayed)", async () => {
        await doPendingTransfer({
          token: erc20, to: recipient, amount: ETH_LIMIT * 2, delay: 3, relayed: true,
        });
      });

      it("should not execute a pending ETH transfer before the confirmation window", async () => {
        try {
          await doPendingTransfer({
            token: ETH_TOKEN, to: recipient, amount: ETH_LIMIT * 2, delay: 1, relayed: false,
          });
        } catch (error) {
          assert.equal(error, "outside of the execution window");
        }
      });

      it("should not execute a pending ETH transfer before the confirmation window (relayed)", async () => {
        try {
          await doPendingTransfer({
            token: ETH_TOKEN, to: recipient, amount: ETH_LIMIT * 2, delay: 1, relayed: true,
          });
        } catch (error) {
          assert.equal(error, "outside of the execution window");
        }
      });

      it("should not execute a pending ETH transfer after the confirmation window", async () => {
        try {
          await doPendingTransfer({
            token: ETH_TOKEN, to: recipient, amount: ETH_LIMIT * 2, delay: 10, relayed: false,
          });
        } catch (error) {
          assert.equal(error, "outside of the execution window");
        }
      });

      it("should not execute a pending ETH transfer after the confirmation window (relayed)", async () => {
        try {
          await doPendingTransfer({
            token: ETH_TOKEN, to: recipient, amount: ETH_LIMIT * 2, delay: 10, relayed: true,
          });
        } catch (error) {
          assert.equal(error, "outside of the execution window");
        }
      });

      it("should cancel a pending ETH transfer", async () => {
        const id = await doPendingTransfer({
          token: ETH_TOKEN, to: recipient, amount: ETH_LIMIT * 2, delay: 0,
        });
        await increaseTime(1);
        const tx = await transferModule.cancelPendingTransfer(wallet.address, id, { from: owner });
        const txReceipt = await transferModule.verboseWaitForTransaction(tx);
        assert.isTrue(await utils.hasEvent(txReceipt, transferModule, "PendingTransferCanceled"),
          "should have generated PendingTransferCanceled event");
        const executeAfter = await transferModule.getPendingTransfer(wallet.address, id);
        assert.equal(executeAfter, 0, "should have cancelled the pending transfer");
      });

      it("should cancel a pending ERC20 transfer", async () => {
        const id = await doPendingTransfer({
          token: erc20, to: recipient, amount: ETH_LIMIT * 2, delay: 0,
        });
        await increaseTime(1);
        const tx = await transferModule.cancelPendingTransfer(wallet.address, id, { from: owner });
        const txReceipt = await transferModule.verboseWaitForTransaction(tx);
        assert.isTrue(await utils.hasEvent(txReceipt, transferModule, "PendingTransferCanceled"),
          "should have generated PendingTransferCanceled event");
        const executeAfter = await transferModule.getPendingTransfer(wallet.address, id);
        assert.equal(executeAfter, 0, "should have cancelled the pending transfer");
      });

      it("should send immediately ETH to a whitelisted address", async () => {
        await transferModule.addToWhitelist(wallet.address, recipient, { from: owner });
        await increaseTime(3);
        await doDirectTransfer({ token: ETH_TOKEN, to: recipient, amount: ETH_LIMIT * 2 });
      });

      it("should send immediately ERC20 to a whitelisted address", async () => {
        await transferModule.addToWhitelist(wallet.address, recipient, { from: owner });
        await increaseTime(3);
        await doDirectTransfer({ token: erc20, to: recipient, amount: ETH_LIMIT * 2 });
      });
    });
  });

  describe("Token Approvals", () => {
    async function doDirectApprove({ signer = owner, amount, relayed = false }) {
      const unspentBefore = await transferModule.getDailyUnspent(wallet.address);
      const params = [wallet.address, erc20.address, spender, amount];
      let txReceipt;
      if (relayed) {
        txReceipt = await manager.relay(transferModule, "approveToken", params, wallet, [signer]);
      } else {
        const tx = await transferModule.approveToken(...params, { from: signer });
        txReceipt = await transferModule.verboseWaitForTransaction(tx);
      }
      assert.isTrue(await utils.hasEvent(txReceipt, transferModule, "Approved"), "should have generated Approved event");
      const unspentAfter = await transferModule.getDailyUnspent(wallet.address);

      const amountInEth = await getEtherValue(amount, erc20.address);
      if (amountInEth < ETH_LIMIT) {
        assert.equal(unspentBefore[0].sub(unspentAfter[0]).toNumber(), amountInEth, "should have updated the daily limit");
      }
      const approval = await erc20.allowance(wallet.address, spender);

      assert.equal(approval.toNumber(), amount, "should have approved the amount");
      return txReceipt;
    }

    it("should appprove an ERC20 immediately when the amount is under the limit", async () => {
      await doDirectApprove({ amount: 10 });
    });

    it("should appprove an ERC20 immediately when the amount is under the limit (relayed) ", async () => {
      await doDirectApprove({ amount: 10, relayed: true });
    });

    it("should appprove an ERC20 immediately when the amount is under the existing approved amount", async () => {
      await doDirectApprove({ amount: 100 });
      await transferModule.approveToken(wallet.address, erc20.address, spender, 10, { from: owner });
      const approval = await erc20.allowance(wallet.address, spender);
      assert.equal(approval.toNumber(), 10);
    });

    it("should not appprove an ERC20 transfer when the signer is not the owner ", async () => {
      try {
        await doDirectApprove({ signer: nonowner, amount: 10 });
        assert.fail("approve should have failed");
      } catch (error) {
        assert.equal(error, "BM: must be owner or module");
      }
    });

    it("should appprove an ERC20 immediately when the spender is whitelisted ", async () => {
      await transferModule.addToWhitelist(wallet.address, spender, { from: owner });
      await increaseTime(3);
      await doDirectApprove({ amount: ETH_LIMIT + 10000 });
    });

    it("should fail to appprove an ERC20 when the amount is above the daily limit ", async () => {
      try {
        await doDirectApprove({ amount: ETH_LIMIT + 10000 });
      } catch (error) {
        assert.equal(error, "above daily limit");
      }
    });
  });

  describe("Call contract", () => {
    let contract;

    beforeEach(async () => {
      contract = await TestContract.new();
      assert.equal(await contract.state(), 0, "initial contract state should be 0");
    });

    async function doCallContract({ value, state, relayed = false }) {
      const dataToTransfer = contract.contract.methods.setState([state]).encodeABI();
      const unspentBefore = await transferModule.getDailyUnspent(wallet.address);
      const params = [wallet.address, contract.address, value, dataToTransfer];
      let txReceipt;
      if (relayed) {
        txReceipt = await manager.relay(transferModule, "callContract", params, wallet, [owner]);
      } else {
        const tx = await transferModule.callContract(...params, { from: owner });
        txReceipt = await transferModule.verboseWaitForTransaction(tx);
      }
      assert.isTrue(await utils.hasEvent(txReceipt, transferModule, "CalledContract"), "should have generated CalledContract event");
      const unspentAfter = await transferModule.getDailyUnspent(wallet.address);
      if (value < ETH_LIMIT) {
        assert.equal(unspentBefore[0].sub(unspentAfter[0]).toNumber(), value, "should have updated the daily limit");
      }
      assert.equal((await contract.state()).toNumber(), state, "the state of the external contract should have been changed");
      return txReceipt;
    }

    it("should not be able to call the wallet itselt", async () => {
      const dataToTransfer = contract.contract.methods.setState([4]).encodeABI();
      const params = [wallet.address, wallet.address, 10, dataToTransfer];
      await utils.assertRevert(transferModule.callContract(...params, { from: owner }), "BT: Forbidden contract");
    });

    it("should not be able to call a module of the wallet", async () => {
      const dataToTransfer = contract.contract.methods.setState([4]).encodeABI();
      const params = [wallet.address, transferModule.address, 10, dataToTransfer];
      await utils.assertRevert(transferModule.callContract(...params, { from: owner }), "BT: Forbidden contract");
    });

    it("should not be able to call a supported ERC20 token contract", async () => {
      const dataToTransfer = contract.contract.methods.setState([4]).encodeABI();
      const params = [wallet.address, erc20.address, 10, dataToTransfer];
      await utils.assertRevert(transferModule.callContract(...params, { from: owner }), "TM: Forbidden contract");
    });

    it("should be able to call a supported token contract which is whitelisted", async () => {
      await transferModule.addToWhitelist(wallet.address, erc20.address, { from: owner });
      await increaseTime(3);
      const dataToTransfer = erc20.contract.methods.transfer([infrastructure, 4]).encodeABI();
      const params = [wallet.address, erc20.address, 0, dataToTransfer];
      await transferModule.callContract(...params, { from: owner });
    });

    it("should call a contract and transfer ETH value when under the daily limit", async () => {
      await doCallContract({ value: 10, state: 3 });
    });

    it("should call a contract and transfer ETH value when under the daily limit (relayed) ", async () => {
      await doCallContract({ value: 10, state: 3, relayed: true });
    });

    it("should call a contract and transfer ETH value above the daily limit when the contract is whitelisted", async () => {
      await transferModule.addToWhitelist(wallet.address, contract.address, { from: owner });
      await increaseTime(3);
      await doCallContract({ value: ETH_LIMIT + 10000, state: 6 });
    });

    it("should fail to call a contract and transfer ETH when the amount is above the daily limit ", async () => {
      await utils.assertRevert(doCallContract({ value: ETH_LIMIT + 10000, state: 6 }, "above daily limit"));
    });
  });

  describe("Approve token and Call contract", () => {
    let contract;

    beforeEach(async () => {
      contract = await TestContract.new();
      assert.equal(await contract.state(), 0, "initial contract state should be 0");
    });

    async function doApproveTokenAndCallContract({
      signer = owner, consumer = contract.address, amount, state, relayed = false, wrapEth = false,
    }) {
      const fun = consumer === contract.address ? "setStateAndPayToken" : "setStateAndPayTokenWithConsumer";
      const token = wrapEth ? weth : erc20;
      const dataToTransfer = contract.contract.methods.fun([state, token.address, amount]).encodeABI();
      const unspentBefore = await transferModule.getDailyUnspent(wallet.address);
      const params = [wallet.address]
        .concat(wrapEth ? [] : [erc20.address])
        .concat([consumer, amount, contract.address, dataToTransfer]);
      const method = wrapEth ? "approveWethAndCallContract" : "approveTokenAndCallContract";
      let txReceipt;
      if (relayed) {
        txReceipt = await manager.relay(transferModule, method, params, wallet, [signer]);
      } else {
        const tx = await transferModule[method](...params, { from: signer });
        txReceipt = await transferModule.verboseWaitForTransaction(tx);
      }
      assert.isTrue(await utils.hasEvent(txReceipt, transferModule, "ApprovedAndCalledContract"), "should have generated CalledContract event");
      const unspentAfter = await transferModule.getDailyUnspent(wallet.address);
      const amountInEth = wrapEth ? amount : await getEtherValue(amount, erc20.address);

      if (amountInEth < ETH_LIMIT) {
        assert.equal(unspentBefore[0].sub(unspentAfter[0]).toNumber(), amountInEth, "should have updated the daily limit");
      }
      assert.equal((await contract.state()).toNumber(), state, "the state of the external contract should have been changed");
      const tokenBalance = await token.balanceOf(contract.address);
      assert.equal(tokenBalance.toNumber(), amount, "the contract should have transfered the tokens");
      return txReceipt;
    }

    // approveTokenAndCallContract

    it("should approve the token and call the contract when under the limit", async () => {
      await doApproveTokenAndCallContract({ amount: 10, state: 3 });
    });

    it("should approve the token and call the contract when under the limit (relayed) ", async () => {
      await doApproveTokenAndCallContract({ amount: 10, state: 3, relayed: true });
    });

    it("should restore existing approved amount after call", async () => {
      await transferModule.approveToken(wallet.address, erc20.address, contract.address, 10, { from: owner });
      const dataToTransfer = contract.contract.methods.setStateAndPayToken([3, erc20.address, 5]).encodeABI();
      await transferModule.approveTokenAndCallContract(
        wallet.address,
        erc20.address,
        contract.address,
        5,
        contract.address,
        dataToTransfer,
        { from: owner }
      );
      const approval = await erc20.allowance(wallet.address, contract.address);

      // Initial approval of 10 is restored, after approving and spending 5
      assert.equal(approval.toNumber(), 10);

      const erc20Balance = await erc20.balanceOf(contract.address);
      assert.equal(erc20Balance.toNumber(), 5, "the contract should have transfered the tokens");
    });

    it("should be able to spend less than approved in call", async () => {
      await transferModule.approveToken(wallet.address, erc20.address, contract.address, 10, { from: owner });
      const dataToTransfer = contract.contract.methods.setStateAndPayToken([3, erc20.address, 4]).encodeABI();
      await transferModule.approveTokenAndCallContract(
        wallet.address,
        erc20.address,
        contract.address,
        5,
        contract.address,
        dataToTransfer,
        { from: owner }
      );
      const approval = await erc20.allowance(wallet.address, contract.address);
      // Initial approval of 10 is restored, after approving and spending 4
      assert.equal(approval.toNumber(), 10);

      const erc20Balance = await erc20.balanceOf(contract.address);
      assert.equal(erc20Balance.toNumber(), 4, "the contract should have transfered the tokens");
    });

    it("should not be able to spend more than approved in call", async () => {
      await transferModule.approveToken(wallet.address, erc20.address, contract.address, 10, { from: owner });
      const dataToTransfer = contract.contract.methods.setStateAndPayToken([3, erc20.address, 6]).encodeABI();
      await utils.assertRevert(transferModule.approveTokenAndCallContract(
        wallet.address,
        erc20.address,
        contract.address,
        5,
        contract.address,
        dataToTransfer,
        { from: owner }
      ), "BT: insufficient amount for call");
    });

    it("should approve the token and call the contract when the token is above the limit and the contract is whitelisted ", async () => {
      await transferModule.addToWhitelist(wallet.address, contract.address, { from: owner });
      await increaseTime(3);
      await doApproveTokenAndCallContract({ amount: ETH_LIMIT + 10000, state: 6 });
    });

    it("should approve the token and call the contract when contract to call is different to token spender", async () => {
      const consumer = await contract.tokenConsumer();
      await doApproveTokenAndCallContract({ amount: 10, state: 3, consumer });
    });

    it("should approve token and call contract when contract != spender, amount > limit and spender is whitelisted ", async () => {
      const consumer = await contract.tokenConsumer();
      await transferModule.addToWhitelist(wallet.address, consumer, { from: owner });
      await increaseTime(3);
      await doApproveTokenAndCallContract({ amount: ETH_LIMIT + 10000, state: 6, consumer });
    });

    it("should fail to approve token and call contract when contract != spender, amount > limit and contract is whitelisted ", async () => {
      const amount = ETH_LIMIT + 10000;
      const consumer = await contract.tokenConsumer();
      await transferModule.addToWhitelist(wallet.address, contract.address, { from: owner });
      await increaseTime(3);
      const dataToTransfer = contract.contract.methods.setStateAndPayTokenWithConsumer([6, erc20.address, amount]).encodeABI();
      await utils.assertRevert(
        transferModule.approveTokenAndCallContract(
          wallet.address, erc20.address, consumer, amount, contract.address, dataToTransfer, { from: owner }),
        "TM: Approve above daily limit",
      );
    });

    it("should fail to approve the token and call the contract when the token is above the daily limit ", async () => {
      try {
        await doApproveTokenAndCallContract({ amount: ETH_LIMIT + 10000, state: 6 });
      } catch (error) {
        assert.equal(error, "above daily limit");
      }
    });

    it("should fail to approve token if the amount to be approved is greater than the current balance", async () => {
      const startingBalance = await erc20.balanceOf(wallet.address);
      await erc20.burn(wallet.address, startingBalance);
      const dataToTransfer = contract.contract.methods.setStateAndPayToken([3, erc20.address, 1]).encodeABI();
      await utils.assertRevert(transferModule.approveTokenAndCallContract(
        wallet.address,
        erc20.address,
        contract.address,
        1,
        contract.address,
        dataToTransfer,
        { from: owner }), "BT: insufficient balance");
    });

    // approveWethAndCallContract

    it("should approve WETH and call the contract when under the limit", async () => {
      await doApproveTokenAndCallContract({ amount: 10, state: 3, wrapEth: true });
    });

    it("should approve WETH and call the contract under the limit when already holding the WETH", async () => {
      const amount = 10;
      await weth.deposit({ value: amount });
      await weth.transfer(wallet.address, amount);
      await doApproveTokenAndCallContract({ amount, state: 3, wrapEth: true });
    });
  });
});
