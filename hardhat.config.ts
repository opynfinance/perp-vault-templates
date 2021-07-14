import '@nomiclabs/hardhat-waffle';
import "@nomiclabs/hardhat-etherscan";
import '@typechain/hardhat';
import "solidity-coverage"
import "hardhat-prettier";
import "hardhat-contract-sizer"

import * as fs from 'fs';
import * as dotenv from 'dotenv'

dotenv.config()

const mnemonic = fs.existsSync('.secret')
  ? fs
      .readFileSync('.secret')
      .toString()
      .trim()
  : "test test test test test test test test test test test junk"

const infuraKey = process.env.INFURA_KEY
const etherscanKey = process.env.ETHERSCAN_KEY

// You need to export an object to set up your config
// Go to https://hardhat.org/config/ to learn more

export default {
  networks: {
    hardhat: {
      forking: {
        url: `https://mainnet.infura.io/v3/${infuraKey}`,
        enabled: process.env.FORK === 'true'
      },
      // gas: 12000000,
      // blockGasLimit: 0x1fffffffffffff,
      // allowUnlimitedContractSize: true,
    },
    ropsten: {
      url: `https://ropsten.infura.io/v3/${infuraKey}`,
      accounts: {
        mnemonic: mnemonic,
      },
    },
    kovan: {
      url: `https://kovan.infura.io/v3/${infuraKey}`,
      accounts: {
        mnemonic: mnemonic,
      },
    },
  },
  solidity: '0.7.6',
  settings: {
    optimizer: {
      enabled: true,
      runs: 1
    }
  },
  typechain: {
    outDir: 'typechain',
    target: 'ethers-v5',
  },
  contractSizer: {
    alphaSort: true,
  },
  etherscan: {
    apiKey: etherscanKey
  },
  mocha: {
    timeout: 150000
  }
};
