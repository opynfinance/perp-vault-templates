# Scripts

## PerpVault & ShortOtokenActionWithSwap Contract Deployment

To deploy a new `OpynPerpVault.sol` and `OpynPerpVault.sol` using hardhat 

**Input**

```sh
npx hardhat run scripts/deploy.ts --network <network-name>
```

**Output**

```sh
OpynPerpVault deployed at 0x1F89774f01A2786bccCFbA9AF924XXXXXX.

ShortOTokenActionWithSwap deployed at 0xc88Bd7eD473b7F6F10e71894C66E4XXXXXX

OpynPerpVault strategy set to action deployed at 0xc88Bd7eD473b7F6F10e71894C664XXXXXX.

OpynPerpVault ownership transferred to 0x364ae680071b81BE368A5AF20A48d1544XXXXXX.

ShortOTokenActionWithSwap ownership transferred to 0x364ae680071b81BE368A5AF20A48d1544XXXXXX.
```

## Verify PerpVault Contracts

**Input**

```sh
npx hardhat verify 0x1F89774f01A2786bccCFbA9AF92E53b04XXXXXX --constructor-args arguments.js --network avalanche;
```

**Output**
```sh
Successfully verified contract OpynPerpVault on Etherscan.
https://snowtrace.io/address/0x1F89774f01A2786bccCFbA9AF92E53b0B4XXXXXX#code
```


## Verify  ShortOtokenActionWithSwap

**Input**

```sh
npx hardhat verify 0xc88Bd7eD473b7F6F10e71894C66EBEbd467Eba93 --constructor-args arguments2.js --network avalanche;
```

**Output**
```sh
Successfully verified contract OpynPerpVault on Etherscan.
https://snowtrace.io/address/0x1F89774f01A2786bccCFbA9AF92E53b0B4XXXXXX#code
```
