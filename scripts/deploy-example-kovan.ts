import { run, ethers } from "hardhat";

async function main() {
  await run("compile");

  // assets on kovan
  const weth = '0xd0a1e359811322d97991e03f863a0c30c2cf029c' // weth
  const swap = '0x79fb4604f2D7bD558Cda0DFADb7d61D98b28CA9f'
  const controller = '0xdee7d0f8ccc0f7ac7e45af454e5e7ec1552e8e4e'
  const vaultType = 0

  const [deployer,] = await ethers.getSigners();

  // We get the contract to deploy
  const OpynPerpVault = await ethers.getContractFactory('OpynPerpVault');
  const vault = await OpynPerpVault.deploy();

  await vault.deployed();

  console.log(`🍩 Vault deployed at ${vault.address}`)

  const ShortAction = await ethers.getContractFactory('MyAction');
  const action = await ShortAction.deploy(
    vault.address,
    weth, 
    swap,
    controller,
    vaultType
  );

  console.log(`🍩 MyAction deployed at ${action.address}`)

  await vault.init(
    weth, // asset (weth)
    deployer.address, // owner.address,
    deployer.address, // feeRecipient
    weth,
    18,
    'MyVault share',
    'MVs',
    [action.address]
  )

  // verify contracts at the end, so we make sure etherscan is aware of their existence
  // verify the vault
  await run("verify:verify", {
    address: vault.address, 
    network: ethers.provider.network
  })

  // verify the action
  await run("verify:verify", {
    address: action.address, 
    network: ethers.provider.network,
    constructorArguments: [
      vault.address,
      weth, 
      swap,
      controller,
      vaultType
    ]
  })  
}

// We recommend this pattern to be able to use async/await everywhere
// and properly handle errors.
main()
  .then(() => process.exit(0))
  .catch(error => {
    console.error(error);
    process.exit(1);
  });
