import { ethers, waffle } from 'hardhat';
import { BigNumber, utils } from 'ethers';
import { SignerWithAddress } from '@nomiclabs/hardhat-ethers/signers';
import { expect } from 'chai';
import { getOrder } from '../utils/orders';
import {
  ShortOToken,
  MockERC20,
  MockWhitelist,
  MockSwap,
  MockController,
  MockPool,
  MockOToken,
  MockOpynOracle,
} from '../../typechain';
import * as fs from 'fs';
import { parseUnits } from '@ethersproject/units';

const mnemonic = fs.existsSync('.secret')
  ? fs.readFileSync('.secret').toString().trim()
  : 'test test test test test test test test test test test junk';

enum ActionState {
  Idle,
  Committed,
  Activated,
}

describe('ShortActionWithSwap Tests', function () {
  const provider = waffle.provider;

  const counterpartyWallet = ethers.Wallet.fromMnemonic(mnemonic, "m/44'/60'/0'/0/30");

  let action: ShortOToken;
  // asset used by this action: in this case, weth
  let token: MockERC20;
  //
  let usdc: MockERC20;

  let swap: MockSwap;
  let whitelist: MockWhitelist;
  let controller: MockController;
  let oracle: MockOpynOracle;

  let accounts: SignerWithAddress[] = [];

  let owner: SignerWithAddress;
  let vault: SignerWithAddress;

  let otokenBad: MockOToken;
  let otoken1: MockOToken;
  let otoken2: MockOToken;

  const otokenBadStrikePrice = 10 * 1e8; 
  const otoken1StrikePrice = 4000 * 1e8; // 4000 
  const otoken2StrikePrice = 5000 * 1e8; // 5000 

  let otoken1Expiry = BigNumber.from(0)
  let otoken2Expiry = BigNumber.from(0)

  // pretend to be gamma margin pool
  let pool: MockPool;

  this.beforeAll('Set accounts', async () => {
    accounts = await ethers.getSigners();
    const [_owner, _vault] = accounts;

    owner = _owner;
    vault = _vault;
  });

  this.beforeAll('Set timestamps', async () => {
    const blockNumber = await provider.getBlockNumber();
    const block = await provider.getBlock(blockNumber);
    const currentTimestamp = block.timestamp;
    // 7 days from now
    otoken1Expiry = BigNumber.from(parseInt(currentTimestamp.toString()) + 86400 * 7);
    otoken2Expiry = BigNumber.from(parseInt(currentTimestamp.toString()) + 86400 * 14);
  })

  this.beforeAll('Deploy Mock contracts', async () => {
    const ERC20 = await ethers.getContractFactory('MockERC20');
    token = (await ERC20.deploy()) as MockERC20;
    await token.init('WETH', 'WETH', 18);

    usdc = (await ERC20.deploy()) as MockERC20;
    await usdc.init('USDC', 'USDC', 6);

    const mintAmount = utils.parseUnits('100', 'ether');
    await token.mint(vault.address, mintAmount);

    // deploy mock swap and mock whitelist
    const Whitelist = await ethers.getContractFactory('MockWhitelist');
    whitelist = (await Whitelist.deploy()) as MockWhitelist;

    const Swap = await ethers.getContractFactory('MockSwap');
    swap = (await Swap.deploy()) as MockSwap;

    const MockPool = await ethers.getContractFactory('MockPool');
    pool = (await MockPool.deploy()) as MockPool;

    const MockOracle = await ethers.getContractFactory('MockOpynOracle');
    oracle = (await MockOracle.deploy()) as MockOpynOracle; 

    const Controller = await ethers.getContractFactory('MockController');
    controller = (await Controller.deploy()) as MockController;
    
    await controller.setPool(pool.address);
    await controller.setOracle(oracle.address)
  });

  describe('deployment test', () => {
    it('deploy', async () => {
      const ShortActionContract = await ethers.getContractFactory('ShortOToken');
      action = (await ShortActionContract.deploy(
        vault.address,
        token.address,
        swap.address,
        ethers.constants.AddressZero, // no auction
        whitelist.address,
        controller.address,
        0 // type 0 vault
      )) as ShortOToken;

      expect((await action.owner()) == owner.address).to.be.true;

      expect((await action.asset()) === token.address).to.be.true;

      expect(await controller.vaultOpened()).to.be.true;

      expect((await token.allowance(action.address, pool.address)).eq(ethers.constants.MaxUint256))
        .to.be.true;
      expect((await token.allowance(action.address, vault.address)).eq(ethers.constants.MaxUint256))
        .to.be.true;

      // init state should be idle
      expect((await action.state()) === ActionState.Idle).to.be.true;

      // whitelist is set
      expect((await action.opynWhitelist()) === whitelist.address).to.be.true;
    });
    it('should deploy with type 1 vault', async () => {
      const ShortActionContract = await ethers.getContractFactory('ShortOToken');
      await ShortActionContract.deploy(
        vault.address,
        token.address,
        swap.address,
        ethers.constants.AddressZero,
        whitelist.address,
        controller.address,
        1 // type 0 vault
      );
      expect((await action.owner()) == owner.address).to.be.true;
      expect((await action.asset()) === token.address).to.be.true;
      expect(await controller.vaultOpened()).to.be.true;
    });
  });

  describe('idle phase', () => {
    before('Mint some eth to action', async () => {
      // mint 10 weth
      const mintAmount = utils.parseUnits('10');
      await token.mint(action.address, mintAmount);
    });
    before('Deploy mock otokens', async () => {
      const MockOToken = await ethers.getContractFactory('MockOToken');
      otoken1 = (await MockOToken.deploy()) as MockOToken;
      await otoken1.init('oWETHUSDC', 'oWETHUSDC', 18);
      await otoken1.initMockOTokenDetail(
        token.address,
        usdc.address,
        token.address,
        otoken1StrikePrice,
        otoken1Expiry,
        false
      );

      otoken2 = (await MockOToken.deploy()) as MockOToken;
      await otoken2.init('oWETHUSDC', 'oWETHUSDC', 18);
      await otoken2.initMockOTokenDetail(
        token.address,
        usdc.address,
        token.address,
        otoken2StrikePrice,
        otoken2Expiry,
        false
      );

      otokenBad = (await MockOToken.deploy()) as MockOToken;
      await otokenBad.init('oWETHUSDC', 'oWETHUSDC', 18);
      await otokenBad.initMockOTokenDetail(
        token.address,
        usdc.address,
        token.address,
        otokenBadStrikePrice,
        otoken2Expiry,
        false
      );

      await oracle.setAssetPrice(token.address, 10000000000);
    });
    it('should revert if calling mint + sell in idle phase', async () => {
      const collateral = utils.parseUnits('10');
      const amountOTokenToMint = 10 * 1e8;
      const premium = parseUnits('1');
      const order = await getOrder(
        action.address,
        otoken1.address,
        amountOTokenToMint,
        counterpartyWallet.address,
        token.address,
        premium.toString(),
        swap.address,
        counterpartyWallet.privateKey
      );
      await expect(
        action.connect(owner).mintAndTradeAirSwapOTC(collateral, amountOTokenToMint, order)
      ).to.be.revertedWith('!Activated');
    });
    it('should not be able to token with invalid strike price', async () => {
      await expect(action.connect(owner).commitOToken(otokenBad.address)).to.be.revertedWith('Strike Price Too Low');
    });
    it('should be able to commit next token', async () => {
      await action.connect(owner).commitOToken(otoken1.address);
      expect((await action.nextOToken()) === otoken1.address);
      expect((await action.state()) === ActionState.Committed).to.be.true;
    });
    it('should revert if the vault is trying to rollover before min commit period is spent', async () => {
      await expect(action.connect(vault).rolloverPosition()).to.be.revertedWith(
        'COMMIT_PHASE_NOT_OVER'
      );
    });
  });

  describe('activating the action', () => {
    const mintOTokenAmount = 10 * 1e8;
    before('increase blocktime to get it over with minimal commit period', async () => {
      const minPeriod = await action.MIN_COMMIT_PERIOD();
      await provider.send('evm_increaseTime', [minPeriod.toNumber()]); // increase time
      await provider.send('evm_mine', []);
    });
    it('should revert if the vault is trying to rollover from non-vault address', async () => {
      await expect(action.connect(owner).rolloverPosition()).to.be.revertedWith('!VAULT');
    });
    it('should be able to roll over the position', async () => {
      await action.connect(vault).rolloverPosition();

      expect((await action.nextOToken()) === ethers.constants.AddressZero);
    });
    it('should get currentValue as total amount in gamma as ', async () => {
      const collateralAmount = utils.parseUnits('10');
      expect((await action.currentValue()).eq(collateralAmount)).to.be.true;
    });
    it('should not be able to mint and sell if less than min premium', async () => {
      const collateralAmount = utils.parseUnits('10');
      const sellAmount = 10 * 1e8;
      const premium = utils.parseUnits('0');
      const order = await getOrder(
        action.address,
        otoken1.address,
        sellAmount,
        counterpartyWallet.address,
        token.address,
        premium.toString(),
        swap.address,
        counterpartyWallet.privateKey
      );
      await expect(action.connect(owner).mintAndTradeAirSwapOTC(collateralAmount, mintOTokenAmount, order)).revertedWith('Need minimum option premium');
    })
    it('should be able to mint and sell in this phase', async () => {
      const collateralAmount = utils.parseUnits('10');
      const otokenBalanceBefore = await otoken1.balanceOf(action.address);
      const sellAmount = 10 * 1e8;
      const premium = utils.parseUnits('1');
      const order = await getOrder(
        action.address,
        otoken1.address,
        sellAmount,
        counterpartyWallet.address,
        token.address,
        premium.toString(),
        swap.address,
        counterpartyWallet.privateKey
      );
      await action.connect(owner).mintAndTradeAirSwapOTC(collateralAmount, mintOTokenAmount, order);
      const otokenBalanceAfter = await otoken1.balanceOf(action.address);
      expect(otokenBalanceAfter.sub(otokenBalanceBefore).eq('0')).to.be.true;
    });
    it('should revert when trying to fill wrong order', async () => {
      const collateralAmount = utils.parseUnits('10');
      const badOrder1 = await getOrder(
        action.address,
        ethers.constants.AddressZero,
        mintOTokenAmount,
        counterpartyWallet.address,
        token.address,
        '1',
        swap.address,
        counterpartyWallet.privateKey
      );
      await expect(action.connect(owner).mintAndTradeAirSwapOTC(collateralAmount, mintOTokenAmount, badOrder1)).to.be.revertedWith(
        'Can only sell otoken'
      );

      const badOrder2 = await getOrder(
        action.address,
        otoken1.address,
        mintOTokenAmount,
        counterpartyWallet.address,
        ethers.constants.AddressZero,
        '1',
        swap.address,
        counterpartyWallet.privateKey
      );
      await expect(action.connect(owner).mintAndTradeAirSwapOTC(collateralAmount, mintOTokenAmount, badOrder2)).to.be.revertedWith(
        'Can only sell for asset'
      );
    });
    it('should not be able to commit next token', async () => {
      await expect(action.connect(owner).commitOToken(otoken2.address)).to.be.revertedWith(
        'Activated'
      );
    });
    it('should revert if the vault is trying to rollover', async () => {
      await expect(action.connect(vault).rolloverPosition()).to.be.revertedWith('!COMMITED');
    });
  });

  describe('close position', () => {
    before('increase blocktime to otoken expiry', async () => {
      await provider.send('evm_setNextBlockTimestamp', [otoken1Expiry.toNumber()]); 
      await provider.send('evm_mine', []);
    });
    it('should revert if the vault is trying to close from non-vault address', async () => {
      await expect(action.connect(owner).closePosition()).to.be.revertedWith('!VAULT');
    });
    it('should be able to close the position', async () => {
      const actionBalanceBefore = await token.balanceOf(action.address);
      const settlePayout = utils.parseUnits('9'); // assume we can get back 9 eth
      await controller.setSettlePayout(settlePayout);

      await action.connect(vault).closePosition();
      const actionBalanceAfter = await token.balanceOf(action.address);
      expect(actionBalanceAfter.sub(actionBalanceBefore).eq(settlePayout)).to.be.true;
      expect((await action.state()) === ActionState.Idle).to.be.true;
    });
    it('should revert if calling mint in idle phase', async () => {
      const collateral = utils.parseUnits('10');
      const amountOTokenToMint = 10 * 1e8;
      const premium = utils.parseUnits('1');
      const order = await getOrder(
        action.address,
        otoken1.address,
        amountOTokenToMint,
        counterpartyWallet.address,
        token.address,
        premium.toString(),
        swap.address,
        counterpartyWallet.privateKey
      );
      await expect(
        action.connect(owner).mintAndTradeAirSwapOTC(collateral, amountOTokenToMint, order)
      ).to.be.revertedWith('!Activated');
    });
  });
});


