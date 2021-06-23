import { ethers } from "hardhat";
import { BigNumber } from 'ethers'
const { createOrder, signOrder } = require('@airswap/utils');

async function main() {

  // edit these
  const otokenToBuy = '' // sender token
  const actionAddress = '' // my action 

  // kovan weth and airswap address
  const wethAddress = '0xd0a1e359811322d97991e03f863a0c30c2cf029c'
  const swap = '0x79fb4604f2D7bD558Cda0DFADb7d61D98b28CA9f'
  
  const [owner, signer] = await ethers.getSigners();

  // amount of otoken to buy
  const senderAmount = (0.1 * 1e8).toString()
  const collateralAmount = (0.1 * 1e18).toString()

  // amount of weth signer is paying
  const signerAmount = (0.05 * 1e18).toString()

  // use the second address derived from the mnemonic
  
  const order = createOrder({
    signer: {
      wallet: signer.address,
      token: wethAddress,
      amount: signerAmount,
    },
    sender: {
      wallet: actionAddress,
      token: otokenToBuy,
      amount: senderAmount,
    },
    expiry: parseInt((Date.now() / 1000).toString()) + 86400
  })

  const signedOrder = await signOrder(order, signer, swap);

  // check signer weth allowance
  const weth = await ethers.getContractAt('IWETH', wethAddress);

  const allowance: BigNumber = await weth.allowance(signer.address, swap)
  if (allowance.lt(signerAmount)) {
    await weth.connect(signer).approve(swap, signerAmount);
  }

  // Owner the order!
  const myAction = await ethers.getContractAt('MyAction', actionAddress);
  const tx = await myAction.connect(owner).mintAndTradeAirSwapOTC(collateralAmount, senderAmount, signedOrder)
  console.log(`🍜 OTC order executed done. tx: ${tx.hash}`)
}

// We recommend this pattern to be able to use async/await everywhere
// and properly handle errors.
main()
  .then(() => process.exit(0))
  .catch((error) => {
    console.error(error);
    process.exit(1);
  });
