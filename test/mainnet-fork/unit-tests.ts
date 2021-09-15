import {ethers, network} from 'hardhat';
import {BigNumber, Signer, utils} from 'ethers';
import {SignerWithAddress} from '@nomiclabs/hardhat-ethers/signers';
import {expect} from 'chai';
import {
  OpynPerpVault,
  IERC20,
  IWETH,
  ShortOTokenActionWithSwap,
  IOtokenFactory,
  IOToken,
  StakedaoEcrvPricer,
  IOracle,
  IWhitelist,
  MockPricer, 
  MockCurveWrapper, 
  IStakeDao
} from '../../typechain';
import * as fs from 'fs';
import {getOrder} from '../utils/orders';

const mnemonic = fs.existsSync('.secret')
  ? fs
      .readFileSync('.secret')
      .toString()
      .trim()
  : 'test test test test test test test test test test test junk';

enum VaultState {
  Emergency,
  Locked,
  Unlocked,
}

enum ActionState {
  Activated,
  Committed,
  Idle,
}

describe('Mainnet Fork Tests', function() {
  let counterpartyWallet = ethers.Wallet.fromMnemonic(
    mnemonic,
    "m/44'/60'/0'/0/30"
  );
  let action1: ShortOTokenActionWithSwap;
  // asset used by this action: in this case, wbtc
  let wbtc: IERC20;
  let usdc: IERC20;
//   let crvRenWsbtc: IERC20;
  let sdcrvRenWsbtc: IERC20;
  let curveLP: IERC20;

  let accounts: SignerWithAddress[] = [];

  let owner: SignerWithAddress;
  let depositor1: SignerWithAddress;
  let depositor2: SignerWithAddress;
  let depositor3: SignerWithAddress;
  let feeRecipient: SignerWithAddress;
  let vault: OpynPerpVault;
  let otokenFactory: IOtokenFactory;
  let sbtcPricer: StakedaoEcrvPricer;
  let wbtcPricer: MockPricer;
  let oracle: IOracle;
  let curveWrapper: MockCurveWrapper;
  let provider: typeof ethers.provider;
  let stakedaoStrategy: IStakeDao;

  /**
   *
   * CONSTANTS
   *
   */
  const day = 86400;
  const controllerAddress = '0x4ccc2339F87F6c59c6893E1A678c2266cA58dC72';
  const whitelistAddress = '0xa5EA18ac6865f315ff5dD9f1a7fb1d41A30a6779';
  const swapAddress = '0x4572f2554421Bd64Bef1c22c8a81840E8D496BeA';
  const oracleAddress = '0x789cD7AB3742e23Ce0952F6Bc3Eb3A73A0E08833';
  const opynOwner = '0x638E5DA0EEbbA58c67567bcEb4Ab2dc8D34853FB';
  const otokenFactoryAddress = '0x7C06792Af1632E77cb27a558Dc0885338F4Bdf8E';
  const usdcAddress = '0xA0b86991c6218b36c1d19D4a2e9Eb0cE3606eB48';
  const wbtcAddress = '0x2260FAC5E5542a773Aa44fBCfeDf7C193bc2C599';
  const sdcrvRenWsbtcAddress = '0x24129B935AfF071c4f0554882C0D9573F4975fEd';
  const curveAddress = '0x7fC77b5c7614E1533320Ea6DDc2Eb61fa00A9714';
  const crvRenWsbtcAddress = '0x075b1bb99792c9E1041bA13afEf80C91a1e70fB3';
  const otokenWhitelistAddress = '0xa5EA18ac6865f315ff5dD9f1a7fb1d41A30a6779';
  const marginPoolAddess = '0x5934807cC0654d46755eBd2848840b616256C6Ef'

  /** Test Scenario Params */
  const p1DepositAmount = BigNumber.from('1000000000')
  const p2DepositAmount = BigNumber.from('7000000000')
  const p3DepositAmount = BigNumber.from('2000000000')
  const premium = BigNumber.from('200000000')

  /** Variables */
  let p1CurveLPDepsited: BigNumber;

  /**
   *
   * Setup
   *
   */

  this.beforeAll('Set accounts', async () => {
    accounts = await ethers.getSigners();

    const [
      _owner,
      _feeRecipient,
      _depositor1,
      _depositor2,
      _depositor3,
    ] = accounts;

    await network.provider.send("hardhat_setBalance", [
      opynOwner,
      "0x1000000000000000000000000000000",
    ]);

    owner = _owner;
    feeRecipient = _feeRecipient;

    depositor1 = _depositor1;
    depositor2 = _depositor2;
    depositor3 = _depositor3;
  });

  this.beforeAll('Connect to mainnet contracts', async () => {
    wbtc = (await ethers.getContractAt('IERC20', wbtcAddress)) as IERC20;
    curveLP = (await ethers.getContractAt('IERC20', crvRenWsbtcAddress)) as IERC20;
    usdc = (await ethers.getContractAt('IERC20', usdcAddress)) as IERC20;
    // crvRenWsbtc = (await ethers.getContractAt('IERC20', crvRenWsbtcAddress)) as IERC20;
    sdcrvRenWsbtc = (await ethers.getContractAt(
      'IERC20',
      sdcrvRenWsbtcAddress
    )) as IERC20;
    otokenFactory = (await ethers.getContractAt(
      'IOtokenFactory',
      otokenFactoryAddress
    )) as IOtokenFactory;
    oracle = (await ethers.getContractAt('IOracle', oracleAddress)) as IOracle;
    stakedaoStrategy = (await ethers.getContractAt('IStakeDao', sdcrvRenWsbtcAddress)) as IStakeDao;
  });

  this.beforeAll('Deploy vault and sell wBTC calls action', async () => {
    const VaultContract = await ethers.getContractFactory('OpynPerpVault');
    vault = (await VaultContract.deploy(
      wbtc.address,
      sdcrvRenWsbtcAddress,
      curveAddress,
      feeRecipient.address,
      'OpynPerpShortVault share',
      'sOPS',
    )) as OpynPerpVault;

    // deploy the short action contract
    const ShortActionContract = await ethers.getContractFactory(
      'ShortOTokenActionWithSwap'
    );
    action1 = (await ShortActionContract.deploy(
      vault.address,
      sdcrvRenWsbtcAddress,
      swapAddress,
      whitelistAddress,
      controllerAddress,
      curveAddress,
      0, // type 0 vault
      wbtc.address,
      20 // 0.2%
    )) as ShortOTokenActionWithSwap;

    await vault.connect(owner).setActions(
      [action1.address]
    );

    const CurveWrapper = await ethers.getContractFactory('MockCurveWrapper') 
    curveWrapper = (await CurveWrapper.deploy(curveAddress, crvRenWsbtcAddress, wbtcAddress)) as MockCurveWrapper;
  });

  this.beforeAll(
    "Deploy sbtcPricer, wbtcPricer and update sbtcPricer in opyn's oracle",
    async () => {
      provider = ethers.provider;

      const PricerContract = await ethers.getContractFactory(
        'StakedaoEcrvPricer'
      );
      sbtcPricer = (await PricerContract.deploy(
        sdcrvRenWsbtc.address,
        wbtc.address,
        oracleAddress,
        curveAddress
      )) as StakedaoEcrvPricer;
      const MockPricerContract = await ethers.getContractFactory('MockPricer');
      wbtcPricer = (await MockPricerContract.deploy(
        oracleAddress
      )) as MockPricer;

      // impersonate owner and change the sbtcPricer
      await owner.sendTransaction({
        to: opynOwner,
        value: utils.parseEther('2.0')
      });
      await provider.send('hardhat_impersonateAccount', [opynOwner]);
      const signer = await ethers.provider.getSigner(opynOwner);
      await oracle
        .connect(signer)
        .setAssetPricer(sdcrvRenWsbtc.address, sbtcPricer.address);
      await oracle
        .connect(signer)
        .setAssetPricer(wbtc.address, wbtcPricer.address);
      await provider.send('evm_mine', []);
      await provider.send('hardhat_stopImpersonatingAccount', [opynOwner]);
    }
  );

  this.beforeAll('whitelist sdcrvRenWsbtc in the Opyn system', async () => {
    const whitelist = (await ethers.getContractAt(
      'IWhitelist',
      otokenWhitelistAddress
    )) as IWhitelist;

    // impersonate owner and change the sbtcPricer
    await owner.sendTransaction({
      to: opynOwner,
      value: utils.parseEther('1.0')
    });
    await provider.send('hardhat_impersonateAccount', [opynOwner]);
    const signer = await ethers.provider.getSigner(opynOwner);
    await whitelist.connect(signer).whitelistCollateral(sdcrvRenWsbtcAddress);
    await whitelist
      .connect(signer)
      .whitelistProduct(
        wbtc.address,
        usdc.address,
        sdcrvRenWsbtcAddress,
        false
      );
    await provider.send('evm_mine', []);
    await provider.send('hardhat_stopImpersonatingAccount', [opynOwner]);
  });

  this.beforeAll('send everyone wbtc', async () => { 
    const wbtcWhale = '0xF977814e90dA44bFA03b6295A0616a897441aceC'

    // send everyone wbtc
    await provider.send('hardhat_impersonateAccount', [wbtcWhale]);
    const signer = await ethers.provider.getSigner(wbtcWhale);
    await wbtc.connect(signer).transfer(counterpartyWallet.address, premium);
    await wbtc.connect(signer).transfer(depositor1.address, p1DepositAmount);
    await wbtc.connect(signer).transfer(depositor2.address, p2DepositAmount);
    await wbtc.connect(signer).transfer(depositor3.address, p3DepositAmount);
    await provider.send('evm_mine', []);
    await provider.send('hardhat_stopImpersonatingAccount', [wbtcWhale]);
  })

  this.beforeAll('prepare counterparty wallet', async () => { 
    // prepare counterparty
    counterpartyWallet = counterpartyWallet.connect(provider);
    await owner.sendTransaction({
      to: counterpartyWallet.address,
      value: utils.parseEther('3000')
    });

    // approve wbtc to be spent by counterparty 
    await wbtc.connect(counterpartyWallet).approve(swapAddress, premium);
  })
  

  describe('check the admin setup', async () => {
    it('contract is initialized correctly', async () => {
      // initial state
      expect((await vault.state()) === VaultState.Unlocked).to.be.true;
      expect((await vault.totalStakedaoAsset()).isZero(), 'total asset should be zero')
        .to.be.true;
    });

    it('should set fee reserve', async () => {
      // 10% reserve
      await vault.connect(owner).setWithdrawReserve(1000);
      expect((await vault.withdrawReserve()).toNumber() == 1000).to.be.true;
    });
  });

  describe('Deposit Tests', async () => {
    let sharesFromDepositingUnderlying;

    // this.beforeAll('set fork to specific block number', async () => {
    //     await network.provider.request({
    //         method: "hardhat_reset",
    //         params: [
    //           {
    //             forking: {
    //               jsonRpcUrl: "https://eth-mainnet.alchemyapi.io/v2/SR-wBhpxMirgFtp4OGeJoWKO1ObmVeFg",
    //               blockNumber: 13188740,
    //             },
    //           },
    //         ],
    //       });
    // })

    // it('p1 deposits underlying', async () => {
    //   // there is no accurate way of estimating this, so just approximating for now
    //   const expectedSdcrvRenWsbtcInVault = p1DepositAmount.mul(95).div(100);

    //   await wbtc.connect(depositor1).approve(vault.address, p1DepositAmount);
    //   await vault.connect(depositor1).depositUnderlying(p1DepositAmount, '0');

    //   const vaultTotal = await vault.totalStakedaoAsset();
    //   const vaultSdcrvRenWsbtcBalance = await sdcrvRenWsbtc.balanceOf(vault.address);
    //   const totalSharesMinted = vaultSdcrvRenWsbtcBalance;

    //   // check the sdcrvRenWsbtc token balances
    //   expect(
    //     (vaultTotal).gte(expectedSdcrvRenWsbtcInVault),
    //     'internal accounting is incorrect'
    //   ).to.be.true;
    //   expect(vaultSdcrvRenWsbtcBalance).to.be.equal(
    //     vaultTotal, 'internal balance is incorrect'
    //   );

    //   // check the minted share balances
    //   sharesFromDepositingUnderlying = await vault.balanceOf(depositor1.address)
    //   expect(sharesFromDepositingUnderlying, 'incorrcect amount of shares minted').to.be.equal(totalSharesMinted)

    // });


    it('p1 deposits crvLP', async () => {
        // there is no accurate way of estimating this, so just approximating for now
        const expectedSdcrvRenWsbtcInVault = p1DepositAmount.mul(95).div(100);
        // p1 deposits to curve first 
        await wbtc.connect(depositor1).approve(curveWrapper.address, p1DepositAmount);
        await curveWrapper.connect(depositor1).add_liquidity(p1DepositAmount, '0');

        p1CurveLPDepsited = await curveLP.balanceOf(depositor1.address);

        await curveLP.connect(depositor1).approve(vault.address, p1CurveLPDepsited);
        await vault.connect(depositor1).depositCrvLP(p1CurveLPDepsited);
  
        const vaultTotal = await vault.totalStakedaoAsset();
        const vaultSdcrvRenWsbtcBalance = await sdcrvRenWsbtc.balanceOf(vault.address);
        const totalSharesMinted = vaultSdcrvRenWsbtcBalance;
  
        // check the sdcrvRenWsbtc token balances
        expect(
          (vaultTotal).gte(expectedSdcrvRenWsbtcInVault),
          'internal accounting is incorrect'
        ).to.be.true;
        expect(vaultSdcrvRenWsbtcBalance).to.be.equal(
          vaultTotal, 'internal balance is incorrect'
        );
  
        // check the minted share balances
        expect((await vault.balanceOf(depositor1.address)), 'incorrcect amount of shares minted').to.be.equal(totalSharesMinted)
      });

    // it('p2 deposits', async () => {
    //   // there is no accurate way of estimating this, so just approximating for now
    //   const expectedSdcrvRenWsbtcInVault = p1DepositAmount.mul(95).div(100);
    //   const sharesBefore = await vault.totalSupply();
    //   const vaultSdcrvRenWsbtcBalanceBefore = await sdcrvRenWsbtc.balanceOf(vault.address);

    //   await wbtc.connect(depositor2).approve(vault.address, p2DepositAmount);
    //   await vault.connect(depositor2).depositUnderlying(p2DepositAmount, '0');

    //   const vaultTotal = await vault.totalStakedaoAsset();
    //   const vaultSdcrvRenWsbtcBalance = await sdcrvRenWsbtc.balanceOf(vault.address);
    //   // check the sdcrvRenWsbtc token balances
    //   // there is no accurate way of estimating this, so just approximating for now
    //   expect(
    //     (vaultTotal).gte(expectedSdcrvRenWsbtcInVault),
    //     'internal accounting is incorrect'
    //   ).to.be.true;
    //   expect(vaultTotal).to.be.equal(
    //     vaultSdcrvRenWsbtcBalance, 'internal balance is incorrect'
    //   );

    //   // check the minted share balances
    //   const stakedaoDeposited = vaultSdcrvRenWsbtcBalance.sub(vaultSdcrvRenWsbtcBalanceBefore);
    //   const shares = sharesBefore.div(vaultSdcrvRenWsbtcBalanceBefore).mul(stakedaoDeposited)
    //   expect((await vault.balanceOf(depositor2.address)), 'incorrect amount of shares minted' ).to.be.equal(shares)
    // });
  });

  describe('withdraw tests', async () => { 
    it('p1 withdraws', async () => {
        // vault balance calculations
        const vaultTotalBefore = await vault.totalStakedaoAsset();
        const vaultSdcrvRenWsbtcBalanceBefore = await sdcrvRenWsbtc.balanceOf(vault.address);
        const sharesBefore = await vault.totalSupply();
        const sharesToWithdraw = await vault.balanceOf(depositor1.address);
  
        // p1 balance calculations 
        const pricePerShare = await stakedaoStrategy.getPricePerFullShare()
        const feeInSdLP = sharesToWithdraw.div(sharesBefore).mul(vaultTotalBefore).mul(5).div(1000)
        const feeInCrvLP = feeInSdLP.mul(pricePerShare).div(utils.parseEther('1.0'));
        const amountTransferredToP1 = p1CurveLPDepsited.sub(feeInCrvLP);
        const balanceOfP1Before = await curveLP.balanceOf(depositor1.address);
  
        // fee calculations 
        const balanceOfFeeRecipientBefore = await sdcrvRenWsbtc.balanceOf(feeRecipient.address);
  
  
        await vault
          .connect(depositor1)
          .withdrawCrvLp(sharesToWithdraw);
  
        // vault balance variables 
        const sharesAfter = await vault.totalSupply();
        const expectedVaultTotalAfter = vaultTotalBefore.mul(sharesAfter).div(sharesBefore);
        const sdcrvRenWsbtcWithdrawn = vaultTotalBefore.sub(expectedVaultTotalAfter);
        const vaultSdcrvRenWsbtcBalanceAfter = await sdcrvRenWsbtc.balanceOf(vault.address);
  
        // fee variables 
        const balanceOfFeeRecipientAfter = await sdcrvRenWsbtc.balanceOf(feeRecipient.address);
        const balanceOfP1After = await curveLP.balanceOf(depositor1.address);
  
        expect(sharesBefore, 'incorrect amount of shares withdrawn').to.be.equal(sharesAfter.add(sharesToWithdraw))
  
        const vaultTotalSdcrvRenWsbtc = await vault.totalStakedaoAsset();
        // check vault balance 
        expect(
          vaultTotalSdcrvRenWsbtc).to.be.within(expectedVaultTotalAfter as any, expectedVaultTotalAfter.add(2) as any,
            'total asset should update'
          );
        expect(vaultSdcrvRenWsbtcBalanceAfter).to.be.within(
          vaultSdcrvRenWsbtcBalanceBefore.sub(sdcrvRenWsbtcWithdrawn).sub(1) as any,
          vaultSdcrvRenWsbtcBalanceBefore.sub(sdcrvRenWsbtcWithdrawn).add(1) as any,
        );

        console.log(feeInCrvLP.toString(), balanceOfP1After.toString(), balanceOfP1Before.toString())
        // check p1 balance 
        expect(balanceOfP1After, 'incorrect wBTC transferred to p1').to.be.within(balanceOfP1Before.add(amountTransferredToP1).sub(5) as any, balanceOfP1Before.add(amountTransferredToP1).add(5) as any)
  
        // check fee 
        expect(balanceOfFeeRecipientAfter, 'incorrect fee paid out').to.be.eq(balanceOfFeeRecipientBefore.add(feeInSdLP))
      });
  })
});