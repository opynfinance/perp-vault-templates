import { ContractFactory } from '@ethersproject/contracts'
import { ethers } from 'hardhat'
import {SignerWithAddress} from '@nomiclabs/hardhat-ethers/signers';
 
import { OpynPerpVault, ShortOTokenActionWithSwap } from "../typechain"
 
const airswapAddress = "0x62069Ff3b5127742B0D86b5fF5C6c21cF5e44154"
const gammaControllerAddress = "0x9e3b94819aaF6de606C4Aa844E3215725b997064"
const gammaWhitelistAddress = "0xe9963AFfc9a53e293c9bB547c52902071e6087c9"
const newOwnerAddress = "0x364ae680071b81BE368A5AF20A48d154EFf0661a"
const underlyingAddress = '0x49D5c2BdFfac6CE2BFdB6640F4F80f226bc10bAB';
let accounts: SignerWithAddress[] = [];
 
async function deployContracts() {
    accounts = await ethers.getSigners();
 
    const [deployer] = accounts;
 
    console.log(deployer.address, "deployer")
    console.log("Account balance:", (await deployer.getBalance()).toString());
    
    //deploy OpynPerpVault
     const OpynPerpVault: ContractFactory = await ethers.getContractFactory('OpynPerpVault');
    const opynPerpVault = await OpynPerpVault.connect(deployer).deploy(
        underlyingAddress,
        newOwnerAddress, // Owner is withdrawal fee recipient 
        newOwnerAddress, // Owner is performance fee recipient
        "StakeDAO ETH Covered Call Strategy",  //change the name based on who it is deployed for
        "sdETHCoveredCall", {gasPrice: 200000000000} //change the name based on who it is deployed for
    ) as OpynPerpVault;
  //  const opynPerpVault = (await ethers.getContractAt('OpynPerpVault', '0xD7f7D613183EF8F10a900982dBf241a4605dE89A')) as OpynPerpVault
 
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
        {gasPrice: 200000000000} // 131000000000
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
    const [deployer] = accounts;
    
    console.log(deployer.address, "deployer")
 
    // set OpynPerpVault strategy
    await opynPerpVault.connect(deployer).setActions([shortOTokenActionWithSwap.address], {gasPrice: 200000000000})
 
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
    const [deployer] = accounts;
 
    console.log("deployer", deployer.address);
    
    // transfer OpynPerpVault ownership
    await opynPerpVault.connect(deployer).transferOwnership(newOwnerAddress, {gasPrice: 200000000000})
                                                                                        
    console.log(`\nOpynPerpVault ownership transferred to ${newOwnerAddress}.`)
 
    // transfer ShortOTokenActionWithSwap ownership
    await shortOTokenActionWithSwap.connect(deployer).transferOwnership(newOwnerAddress, {gasPrice: 200000000000})
 
    console.log(`\nShortOTokenActionWithSwap ownership transferred to ${newOwnerAddress}.`)
 
    return;
}
 
deployContracts()
//getContracts()
    .then(setPerpVaultStrategy)
    .then(setupOwnership)
    .then(() => process.exit(0))
    .catch((error: Error) => {
        console.error(error)
        process.exit(1)
    })


// async function getContracts() {
//     const opynPerpVault = (await ethers.getContractAt('OpynPerpVault', '0x93CDea35C96942844cADBf192dF7d3f5A5XXXXX')) as OpynPerpVault
//     const shortOTokenActionWithSwap = (await ethers.getContractAt('ShortOTokenActionWithSwap', '0xa9c9C8fE017Ca500198270Df010669066BXXXXX')) as ShortOTokenActionWithSwap
//     return { opynPerpVault, shortOTokenActionWithSwap }
//  }
