const { createOrder, signTypedDataOrder } = require("@airswap/utils");
import { BigNumber, constants } from "ethers";
const v4orderUtils = require("@0x/protocol-utils");

export const get0xLimitOrder = async (
  makerToken: string,
  takerToken: string,
  makerAmount: number,
  takerAmount: number,
  maker: string,
  privateKey: string
) => {
  const takerTokenFeeAmount = 0;
  const salt = BigNumber.from(Date.now().toFixed(0));
  const order = new v4orderUtils.LimitOrder({
    chainId: 1,
    makerToken,
    takerToken,
    makerAmount,
    takerAmount,
    maker,
    salt,
    takerTokenFeeAmount,
    expiry: parseInt((Date.now() / 1000).toString(10)) + 86400 * 100,
  });
  // Maker's 32-byte private key, in hex.
  const signature = await order.getSignatureWithKey(privateKey, v4orderUtils.SignatureType.EIP712);
  // override the bignumber type with ether.Bignumber
  const newOrder = {
    ...order,
    makerAmount: BigNumber.from(order.makerAmount.toString()), //.toString(),
    takerAmount: BigNumber.from(order.takerAmount.toString()), //.toString(),
    salt: BigNumber.from(order.salt),
    takerTokenFeeAmount: BigNumber.from(takerTokenFeeAmount),
    signature,
  };
  return newOrder;
};

export const get0xRFQOrder = async (
  makerToken: string,
  takerToken: string,
  makerAmount: number,
  takerAmount: number,
  maker: string,
  txOrigin: string,
  privateKey: string
) => {
  const salt = BigNumber.from(Date.now().toFixed(0));
  const order = new v4orderUtils.RfqOrder({
    makerToken,
    takerToken,
    makerAmount,
    takerAmount,
    maker,
    salt,
    expiry: parseInt((Date.now() / 1000).toString(10)) + 86400 * 100,
    txOrigin,
  });
  // Maker's 32-byte private key, in hex.
  const signature = await order.getSignatureWithKey(privateKey, v4orderUtils.SignatureType.EIP712);
  // override the bignumber type with ether.Bignumber
  const newOrder = {
    ...order,
    makerAmount: BigNumber.from(order.makerAmount.toString()), //.toString(),
    takerAmount: BigNumber.from(order.takerAmount.toString()), //.toString(),
    salt: BigNumber.from(order.salt),
    signature,
  };
  return newOrder;
};

export const getAirSwapOrder = async (
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
      wallet: constants.AddressZero,
    },
    expiry: parseInt((Date.now() / 1000).toString(10)) + 86400 * 100,
  });
  const signedOrder = await signTypedDataOrder(order, privateKey, swapContract);
  return signedOrder;
};
