import { ethers } from 'hardhat';
import * as sigUtil from 'eth-sig-util'
import * as ethUtil from 'ethereumjs-util'

// import { createOrder, signTypedDataOrder } from "@airswap/utils"

// export const getOrder = async (
//   sender: string,
//   senderLowerToken: string,
//   senderHigherToken: string,
//   senderTokenAmount: string,
//   signer: string,
//   signerToken: string,
//   signerTokenAmount: string | number,
//   swapContract: string,
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
//       token: senderHigherToken,
//       amount: senderTokenAmount,
//       lowerToken: senderLowerToken,
//     },
//     affiliate: {
//       wallet: ethers.constants.AddressZero,
//     },
//   });
//   const signedOrder = await signTypedDataOrder(order, privateKey, swapContract);
//   return signedOrder;
// };

export const getOrder = async (
  sender: string,
  // senderLowerToken: string,
  senderHigherToken: string,
  senderTokenAmount: string,
  signer: string,
  signerToken: string,
  signerTokenAmount: string | number,
  swapContract: string,
  privateKey: string,
): Promise<any> => {
  const order = createOrder({
    expiry: Date.now().toString(),
    signer: {
      wallet: signer,
      token: signerToken,
      amount: signerTokenAmount,
    },
    sender: {
      wallet: sender,
      token: senderHigherToken,
      amount: senderTokenAmount,
      // lowerToken: senderLowerToken,
    },
    affiliate: {
      wallet: ethers.constants.AddressZero,
    },
  });
  const signedOrder = await signTypedDataOrder(order, privateKey, swapContract);
  return signedOrder;
};

const SECONDS_IN_DAY = 86400
const ADDRESS_ZERO = '0x0000000000000000000000000000000000000000'
const DOMAIN_NAME = 'SWAP'
const DOMAIN_VERSION = '2'

const signatureTypes: Record<string, string> = {
  INTENDED_VALIDATOR: '0x00',
  SIGN_TYPED_DATA: '0x01',
  PERSONAL_SIGN: '0x45',
}

type UnsignedOrder = {
  nonce: string
  expiry: string
  signer: OrderParty
  sender: SenderParty
  affiliate: OrderParty
}

type Party = {
  kind: string
  token: string
  id?: string
  amount?: string
}

type OrderParty = Party & {
  wallet: string
}

type SenderParty = OrderParty & {
  // lowerToken: string
}

const defaultParty: OrderParty = {
  kind: '0x36372b07',
  wallet: ADDRESS_ZERO,
  token: ADDRESS_ZERO,
  amount: '0',
  id: '0',
}

const defaultSenderParty: SenderParty = {
  kind: '0x36372b07',
  wallet: ADDRESS_ZERO,
  token: ADDRESS_ZERO,
  amount: '0',
  id: '0',
  // lowerToken: ADDRESS_ZERO
}

type Signature = {
  version: string
  signatory: string
  validator: string
  v: string
  r: string
  s: string
}

type Order = UnsignedOrder & {
  signature: Signature
}

const EIP712 = {
  EIP712Domain: [
    { name: 'name', type: 'string' },
    { name: 'version', type: 'string' },
    { name: 'verifyingContract', type: 'address' },
  ],
  Order: [
    { name: 'nonce', type: 'uint256' },
    { name: 'expiry', type: 'uint256' },
    { name: 'signer', type: 'Party' },
    { name: 'sender', type: 'Party' },
    { name: 'affiliate', type: 'Party' },
  ],
  Party: [
    { name: 'kind', type: 'bytes4' },
    { name: 'wallet', type: 'address' },
    { name: 'token', type: 'address' },
    { name: 'amount', type: 'uint256' },
    { name: 'id', type: 'uint256' },
  ],
  // SenderParty: [
  //   { name: 'kind', type: 'bytes4' },
  //   { name: 'wallet', type: 'address' },
  //   { name: 'token', type: 'address' },
  //   { name: 'amount', type: 'uint256' },
  //   { name: 'id', type: 'uint256' },
    // { name: 'lowerToken', type: 'address' },
  // ],
}

function createOrder({
  expiry = Math.round(Date.now() / 1000 + SECONDS_IN_DAY).toString(),
  nonce = Date.now(),
  signer = {},
  sender = {},
  affiliate = {},
}): UnsignedOrder {
  return lowerCaseAddresses({
    expiry: String(expiry),
    nonce: String(nonce),
    signer: { ...defaultParty, ...signer },
    sender: { ...defaultSenderParty, ...sender },
    affiliate: { ...defaultParty, ...affiliate },
  })
}

function lowerCaseAddresses(obj: any): any {
  for (const key in obj) {
    if (typeof obj[key] === 'object') {
      lowerCaseAddresses(obj[key])
    } else if (typeof obj[key] === 'string' && obj[key].indexOf('0x') === 0) {
      obj[key] = obj[key].toLowerCase()
    } else {
      obj[key] = obj[key].toString()
    }
  }
  return obj
}

async function signTypedDataOrder(
  order: UnsignedOrder,
  privateKey: string,
  swapContract: string
): Promise<Order> {
  return {
    ...order,
    signature: await createTypedDataSignature(order, privateKey, swapContract),
  }
}

async function createTypedDataSignature(
  unsignedOrder: UnsignedOrder,
  privateKey: string,
  swapContract: string
): Promise<Signature> {
  const signedMsg = sigUtil.signTypedData_v4(ethUtil.toBuffer(privateKey), {
    data: {
      types: EIP712,
      domain: {
        name: DOMAIN_NAME,
        version: DOMAIN_VERSION,
        verifyingContract: swapContract,
      },
      primaryType: 'Order',
      message: unsignedOrder,
    },
  })

  const sig = ethers.utils.splitSignature(signedMsg)
  const { r, s, v } = sig

  return {
    signatory: `0x${ethUtil
      .privateToAddress(ethUtil.toBuffer(privateKey))
      .toString('hex')
      .toLowerCase()}`,
    validator: swapContract.toLowerCase(),
    version: signatureTypes.SIGN_TYPED_DATA,
    v: String(v),
    r,
    s,
  }
}


