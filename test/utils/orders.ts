import { ethers } from "hardhat";
const { createOrder, signTypedDataOrder } = require("@airswap/utils");
import { BigNumber } from "ethers";

export const getOrder = async (
  sender: string,
  senderToken: string,
  senderTokenAmount: BigNumber | number,
  signer: string,
  signerToken: string,
  signerTokenAmount: string | number,
  swapContract: string,
  privateKey: any
) => {
  const order = createOrder({
    signer: {
      wallet: signer,
      token: signerToken,
      amount: signerTokenAmount,
    },
    sender: {
      wallet: sender,
      token: senderToken,
      amount: senderTokenAmount,
    },
    affiliate: {
      wallet: ethers.constants.AddressZero,
    },
    expiry: parseInt((Date.now() / 1000).toString()) + 86400 * 100,
  });
  const signedOrder = await signTypedDataOrder(order, privateKey, swapContract);
  return signedOrder;
};
