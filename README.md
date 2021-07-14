# OpynPerpVault Template Contracts

This is a repo containing Opyn's Perpetual Vault Template Smart Contracts. These are a set of templates designed to make it easier for developers to build option-powered perpetual products on top of Opyn v2. With these templates, anyone can create custom vaults with different strategies and open up for users to invest. 

## Documentation 

We reccomend starting out by reading the [documentation](https://opyn.gitbook.io/perp-vault/)

## Setup

### Installing Packages

Run the following to install the required packages. 

```
npm install
```

### Setting up mnemonic

add a `.secret` file containing your testing mnemonic in the current folder. You will need to set up the mnemonic to deploy any contracts on mainnet. 

### Setting up infura and etherscan keys

Run the following to set your infura key. You will need to set up an infura key to run any mainnet fork tests. 
```
export INFURA_KEY="YOUR-KEY-HERE"
```

Run the following to set your etherscan key. You will need to set up the etherscan key to verify contracts on etherscan. 
```
export ETHERSCAN_KEY="YOUR-KEY-HERE"
```

## Testing

### Unit tests

```
npm run test
```

### Mainnet fork test

```
npm run test:fork
```

## Coverage

Generate test coverage report

```
npx hardhat coverage
```