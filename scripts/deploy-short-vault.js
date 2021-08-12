// We require the Hardhat Runtime Environment explicitly here. This is optional
// but useful for running the script in a standalone fashion through `node <script>`.
//
// When running the script with `hardhat run <script>` you'll find the Hardhat
// Runtime Environment's members available in the global scope.
const hre = require('hardhat');

async function main() {
  const asset = '0xd0a1e359811322d97991e03f863a0c30c2cf029c'
  const swap = '0x79fb4604f2D7bD558Cda0DFADb7d61D98b28CA9f'
  const weth = '0xd0a1e359811322d97991e03f863a0c30c2cf029c'
  const whitelist = '0x9164eb40a1b59512f1803ab4c2d1de4b89627a93'
  const controller = '0xdee7d0f8ccc0f7ac7e45af454e5e7ec1552e8e4e'
  const vaultType = 0

  const [deployer,] = await hre.ethers.getSigners();

  // We get the contract to deploy
  const OpynPerpVault = await hre.ethers.getContractFactory('OpynPerpVault');
  const vault = await OpynPerpVault.deploy();

  await vault.deployed();

  console.log(`Vault deployed at ${vault.address}`)

  const ShortAction = await hre.ethers.getContractFactory('ShortOTokenActionWithSwap');
  const shortAction = await ShortAction.deploy(
    vault.address, // vault
    asset,
    swap,
    whitelist, 
    controller,
    vaultType
  );

  console.log(`ShortAction deployed at ${shortAction.address}`)

  await vault.init(
    asset, // asset (weth)
    deployer.address, // owner.address,
    deployer.address, // feeRecipient
    weth,
    18,
    'OpynPerpShortVault share',
    'sOPS',
    [shortAction.address]
  )

  console.log(`vault init done`)
  console.log(`
  verify vault contract with 💽:
  npx hardhat verify --network kovan ${vault.address}
`)

  console.log(`
  verify short action with 💽:
  npx hardhat verify --network kovan ${shortAction.address} "${vault.address}" "${asset}" "${swap}" "${whitelist}" "${controller}" "${vaultType}"
  `)
}

// We recommend this pattern to be able to use async/await everywhere
// and properly handle errors.
main()
  .then(() => process.exit(0))
  .catch((error) => {
    console.error(error);
    process.exit(1);
  });
