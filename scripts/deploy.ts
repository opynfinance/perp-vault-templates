import { ContractFactory } from '@ethersproject/contracts'
import { ethers } from 'hardhat'

import { OpynPerpVault, ShortOTokenActionWithSwap } from "../typechain"

const airswapAddress = "0x4572f2554421Bd64Bef1c22c8a81840E8D496BeA"
const curveSbtcSwapAddress = "0x7fC77b5c7614E1533320Ea6DDc2Eb61fa00A9714"
const gammaControllerAddress = "0x4ccc2339F87F6c59c6893E1A678c2266cA58dC72"
const gammaWhitelistAddress = "0xa5EA18ac6865f315ff5dD9f1a7fb1d41A30a6779"
const newOwnerAddress = "0xb36a0671B3D49587236d7833B01E79798175875f"
const sdcrvRenWsbtcAddress = "0x24129B935AfF071c4f0554882C0D9573F4975fEd"
const wbtcAddress = '0x2260FAC5E5542a773Aa44fBCfeDf7C193bc2C599';

async function deployContracts() {
    // deploy OpynPerpVault
    const OpynPerpVault: ContractFactory = await ethers.getContractFactory('OpynPerpVault');
    const opynPerpVault = await OpynPerpVault.deploy(
        wbtcAddress,
        sdcrvRenWsbtcAddress,
        curveSbtcSwapAddress,
        newOwnerAddress, // Owner is fee recipient 
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
        sdcrvRenWsbtcAddress,
        airswapAddress,
        gammaWhitelistAddress,
        gammaControllerAddress,
        curveSbtcSwapAddress,
        0, // type 0 vault
        wbtcAddress,
        4, // 0.04%
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
