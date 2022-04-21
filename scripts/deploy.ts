import { ethers } from 'hardhat'
import { ContractFactory } from '@ethersproject/contracts'
import { SignerWithAddress } from '@nomiclabs/hardhat-ethers/signers';
import { OpynPerpVault, ShortOTokenActionWithSwap } from '../typechain'
import { DeploymentParams } from './deploy-arguments';
 
let accounts: SignerWithAddress[] = [];
 
async function deployContracts() {

    accounts = await ethers.getSigners();
    const [deployer] = accounts;
    console.log(deployer.address, "deployer")
    console.log("Account balance:", (await deployer.getBalance()).toString());
    
    // deploys OpynPerpVault
    const OpynPerpVault: ContractFactory = await ethers.getContractFactory('OpynPerpVault');
    const opynPerpVault = await OpynPerpVault.connect(deployer).deploy(
        DeploymentParams.underlyingAddress,
        DeploymentParams.newOwnerAddress, // Owner is withdrawal fee recipient 
        DeploymentParams.newOwnerAddress, // Owner is performance fee recipient
        DeploymentParams.vaultStrategyName,  
        DeploymentParams.vaultStrategyShortName, {gasPrice: 200000000000} 
    ) as OpynPerpVault;
 
    console.log(`\nOpynPerpVault deployed at ${opynPerpVault.address}.`)
 
    // deploys ShortOTokenActionWithSwap
    const ShortOTokenActionWithSwap = await ethers.getContractFactory('ShortOTokenActionWithSwap' );
    const shortOTokenActionWithSwap = await ShortOTokenActionWithSwap.connect(deployer).deploy(
        opynPerpVault.address,
        DeploymentParams.airswapAddress,
        DeploymentParams.gammaWhitelistAddress,
        DeploymentParams.gammaControllerAddress,
        DeploymentParams.vaultType, 
        DeploymentParams.underlyingAddress,
        DeploymentParams.minProfits, 
        {gasPrice: 200000000000} 
    ) as ShortOTokenActionWithSwap;

    console.log(`\nShortOTokenActionWithSwap deployed at ${shortOTokenActionWithSwap.address}.`);

    return { opynPerpVault, shortOTokenActionWithSwap }
}

async function setPerpVaultStrategy({ opynPerpVault, shortOTokenActionWithSwap,}: {
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
 
async function setupOwnership({opynPerpVault,shortOTokenActionWithSwap,}: {
    opynPerpVault: OpynPerpVault;
    shortOTokenActionWithSwap: ShortOTokenActionWithSwap;
}) {
    accounts = await ethers.getSigners();
    const [deployer] = accounts;
    console.log("deployer", deployer.address);
    
    // transfer OpynPerpVault ownership
    await opynPerpVault.connect(deployer).transferOwnership(DeploymentParams.newOwnerAddress, {gasPrice: 200000000000})                                                             
    console.log(`\nOpynPerpVault ownership transferred to ${DeploymentParams.newOwnerAddress}.`)
 
    // transfer ShortOTokenActionWithSwap ownership
    await shortOTokenActionWithSwap.connect(deployer).transferOwnership(DeploymentParams.newOwnerAddress, {gasPrice: 200000000000})
    console.log(`\nShortOTokenActionWithSwap ownership transferred to ${DeploymentParams.newOwnerAddress}.`)
 
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


