import { run, ethers } from "hardhat";

const { createOrder, signOrder } = require('@airswap/utils');

async function main() {

  const otokenToBuy = '0xbceb20506a60a59a45109e12d245ac7e2daf2f60' // sender token
  const weth = '0xd0a1e359811322d97991e03f863a0c30c2cf029c' // signer token
  
  const swap = '0x79fb4604f2D7bD558Cda0DFADb7d61D98b28CA9f'
  const action = '0xcA50033F6c3e286D9891f6658298f6EbfD9A8D43'
  
  const [, signer] = await ethers.getSigners();

  // amount of otoken to buy
  const senderAmount = (0.9 * 1e8).toString()
  const collateralAmount = (0.9 * 1e18).toString()

  // amount of weth signer is paying
  const signerAmount = (0.1 * 1e18).toString()

  // use the second address derived from the mnemonic
  
  const order = createOrder({
    signer: {
      wallet: signer.address,
      token: weth,
      amount: signerAmount,
    },
    sender: {
      wallet: action,
      token: otokenToBuy,
      amount: senderAmount,
    },
    expiry: parseInt((Date.now() / 1000).toString()) + 86400
  })

  const signedOrder = await signOrder(order, signer, swap);

  // Fill the order!
  const MyAction = await ethers.getContractFactory('MyAction');
  const myAction = MyAction.attach(action)
  await myAction.mintAndSellOToken(collateralAmount, senderAmount, signedOrder)
}

// We recommend this pattern to be able to use async/await everywhere
// and properly handle errors.
main()
  .then(() => process.exit(0))
  .catch((error) => {
    console.error(error);
    process.exit(1);
  });
