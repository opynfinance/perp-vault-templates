import { ethers } from "hardhat";

async function main() {
  const proxyAddress = '0x745832Cda9f8Bee70C8BE7325876B3c6FBe113b7'
  
  // use the second address as depositor
  const [, secondAddress] = await ethers.getSigners();

  // amount of otoken to buy
  const depositAmount = ethers.utils.parseEther('0.05')

  
  const Proxy = await ethers.getContractFactory('ETHProxy');
  const proxy = Proxy.attach(proxyAddress)
  await proxy.connect(secondAddress).depositETH({ value: depositAmount })
  console.log(`Deposit into PerpVault done!`)
}

// We recommend this pattern to be able to use async/await everywhere
// and properly handle errors.
main()
  .then(() => process.exit(0))
  .catch((error) => {
    console.error(error);
    process.exit(1);
  });
