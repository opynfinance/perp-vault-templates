import { ContractFactory } from '@ethersproject/contracts'
import { ethers } from 'hardhat'
import {SignerWithAddress} from '@nomiclabs/hardhat-ethers/signers';

import { OpynPerpVault, ShortOTokenActionWithSwap } from "../typechain"

const airswapAddress = "0x4572f2554421Bd64Bef1c22c8a81840E8D496BeA"
const gammaControllerAddress = "0x4ccc2339F87F6c59c6893E1A678c2266cA58dC72"
const gammaWhitelistAddress = "0xa5EA18ac6865f315ff5dD9f1a7fb1d41A30a6779"
const newOwnerAddress = "0xb36a0671B3D49587236d7833B01E79798175875f"
const underlyingAddress = '0x2260FAC5E5542a773Aa44fBCfeDf7C193bc2C599';
let accounts: SignerWithAddress[] = [];

async function deployContracts() {
    accounts = await ethers.getSigners();

    const [
    _1,
    _2,
    _3,
    _4,
    _5,
    _6,
    _7,
    _8,
    deployer
    ] = accounts;

    console.log(deployer.address, "deployer")
    
    // deploy OpynPerpVault
     const OpynPerpVault: ContractFactory = await ethers.getContractFactory('OpynPerpVault');
    const opynPerpVault = await OpynPerpVault.connect(deployer).deploy(
        underlyingAddress,
        newOwnerAddress, // Owner is withdrawal fee recipient 
        newOwnerAddress, // Owner is performance fee recipient
        "StakeDAO Aave Covered Call Strategy",
        "aaveCoveredCall", {gasPrice: 150000000000}
    ) as OpynPerpVault;
   // const opynPerpVault = (await ethers.getContractAt('OpynPerpVault', '0x227e4635c5fe22D1e36daB1C921B62f8ACC451b9')) as OpynPerpVault

    console.log(`\nOpynPerpVault deployed at ${opynPerpVault.address}.`)

    // deploy ShortOTokenActionWithSwap
    const ShortOTokenActionWithSwap = await ethers.getContractFactory(
        'ShortOTokenActionWithSwap'
    );
    const shortOTokenActionWithSwap = await ShortOTokenActionWithSwap.connect(deployer).deploy(
        opynPerpVault.address,
        airswapAddress,
        gammaWhitelistAddress,
        gammaControllerAddress,
        0, // type 0 vault
        underlyingAddress,
        4, // 0.04%
        {gasPrice: 131000000000}
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
    accounts = await ethers.getSigners();
    const [
        _1,
        _2,
        _3,
        _4,
        _5,
        _6,
        _7,
        _8,
        deployer
        ] = accounts;
    
    console.log(deployer.address, "deployer")

    // set OpynPerpVault strategy
    await opynPerpVault.connect(deployer).setActions([shortOTokenActionWithSwap.address], {gasPrice: 150000000000})

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
    accounts = await ethers.getSigners();
    const [
        _1,
        _2,
        _3,
        _4,
        _5,
        _6,
        _7,
        _8,
        deployer
        ] = accounts;

    console.log("deployer", deployer.address);
    
    // transfer OpynPerpVault ownership
    await opynPerpVault.connect(deployer).transferOwnership(newOwnerAddress, {gasPrice: 150000000000})

    console.log(`\nOpynPerpVault ownership transferred to ${newOwnerAddress}.`)

    // transfer ShortOTokenActionWithSwap ownership
    await shortOTokenActionWithSwap.connect(deployer).transferOwnership(newOwnerAddress, {gasPrice: 150000000000})

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
