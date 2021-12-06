import { ethers } from 'hardhat';

const {
  createOrder,
  orderToParams,
  createSignature,
} = require('@airswap/utils')


// export const getOrder = async (
//   sender: string,
//   // senderToken: string,
//   // senderTokenAmount: string,
//   signer: string,
//   signerToken: string,
//   signerTokenAmount: string | number,
//   // swapContract: string,
//   privateKey: string,
// ): Promise<any> => {
//   const order = createOrder({
//     expiry: Date.now().toString(),
//     signer: {
//       wallet: signer,
//       token: signerToken,
//       amount: signerTokenAmount,
//     },
//     sender: {
//       wallet: sender,
//       // token: senderToken,
//       // amount: senderTokenAmount,
//     },
//     affiliate: {
//       wallet: ethers.constants.AddressZero,
//     },
//   });
//   const signedOrder = await signTypedDataOrder(order, privateKey, '');
//   return signedOrder;
// };

const CHAIN_ID = 31337

export const getOrder = async (
  signer: string,
  signerToken: string,
  signerTokenAmount: string | number,
  sender: string,
  senderToken: string,
  senderTokenAmount: string,
  signatory: string,
  swap: string
): Promise<any> => {
  const unsignedOrder = createOrder({
    protocolFee: '0',
    signerWallet: signer,
    signerToken: signerToken,
    signerAmount: signerTokenAmount,
    senderWallet: sender,
    senderToken: senderToken,
    senderAmount: senderTokenAmount,
  });

  const signature = await createSignature(
      unsignedOrder,
      signatory,
      swap,
      31337
    )

  console.log('signature orders.ts: ', signature)

  return orderToParams({
    ...unsignedOrder,
    ...(signature),
  })
};