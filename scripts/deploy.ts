import { ContractFactory } from '@ethersproject/contracts'
import { ethers } from 'hardhat'

import { OpynPerpVault, ShortOTokenActionWithSwap } from "../typechain"

const airswapAddress = "0x4572f2554421Bd64Bef1c22c8a81840E8D496BeA"
const curveStableSwapSETHPoolAddress = "0xc5424B857f758E906013F3555Dad202e4bdB4567"
const gammaControllerAddress = "0x4ccc2339F87F6c59c6893E1A678c2266cA58dC72"
const gammaWhitelistAddress = "0xa5EA18ac6865f315ff5dD9f1a7fb1d41A30a6779"
const newOwnerAddress = "0xb36a0671B3D49587236d7833B01E79798175875f"
const sdeCRVTokenAddress = "0xa2761B0539374EB7AF2155f76eb09864af075250"
const vaultWithdrawalFeeRecipientAddress = "0x9d75c85f864ab9149e23f27c35addae09b9b909c"
const wETHAddress = "0xc02aaa39b223fe8d0a0e5c4f27ead9083c756cc2"

async function deployContracts() {
    // deploy OpynPerpVault
    const OpynPerpVault: ContractFactory = await ethers.getContractFactory('OpynPerpVault');
    const opynPerpVault = await OpynPerpVault.deploy(
        sdeCRVTokenAddress,
        curveStableSwapSETHPoolAddress,
        vaultWithdrawalFeeRecipientAddress,
        "StakeDAO ETH Covered Call Strategy",
        "sdETHCoveredCall"
    ) as OpynPerpVault;

    console.log(`\nOpynPerpVault deployed at ${opynPerpVault.address}.`)

    // deploy ShortOTokenActionWithSwap
    const ShortOTokenActionWithSwap = await ethers.getContractFactory(
        'ShortOTokenActionWithSwap'
    );
    const shortOTokenActionWithSwap = await ShortOTokenActionWithSwap.deploy(
        opynPerpVault.address,
        sdeCRVTokenAddress,
        airswapAddress,
        gammaWhitelistAddress,
        gammaControllerAddress,
        curveStableSwapSETHPoolAddress,
        0, // type 0 vault
        wETHAddress,
        8, // 0.08%
    ) as ShortOTokenActionWithSwap;

    console.log(`\nShortOTokenActionWithSwap deployed at ${shortOTokenActionWithSwap.address}.`)

    return { opynPerpVault, shortOTokenActionWithSwap }
}

async function setPerpVaultStrategy({
    opynPerpVault,
    shortOTokenActionWithSwap,
}: {
    opynPerpVault: OpynPerpVault;
    shortOTokenActionWithSwap: ShortOTokenActionWithSwap;
}) {
    // set OpynPerpVault strategy
    await opynPerpVault.setActions([shortOTokenActionWithSwap.address])

    console.log(`\nOpynPerpVault strategy set to action deployed at ${shortOTokenActionWithSwap.address}.`)

    return { opynPerpVault, shortOTokenActionWithSwap }
}

async function setupOwnership({
    opynPerpVault,
    shortOTokenActionWithSwap,
}: {
    opynPerpVault: OpynPerpVault;
    shortOTokenActionWithSwap: ShortOTokenActionWithSwap;
}) {
    // transfer OpynPerpVault ownership
    await opynPerpVault.transferOwnership(newOwnerAddress)

    console.log(`\nOpynPerpVault ownership transferred to ${newOwnerAddress}.`)

    // transfer ShortOTokenActionWithSwap ownership
    await shortOTokenActionWithSwap.transferOwnership(newOwnerAddress)

    console.log(`\nShortOTokenActionWithSwap ownership transferred to ${newOwnerAddress}.`)

    return;
}

deployContracts()
    .then(setPerpVaultStrategy)
    .then(setupOwnership)
    .then(() => process.exit(0))
    .catch((error: Error) => {
        console.error(error)
        process.exit(1)
    })
