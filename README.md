# OpynPerpVault Template Contracts

This is a repo containing Opyn's Perpetual Vault Template Smart Contracts. These are a set of templates designed to make it easier for developers to build option-powered perpetual products on top of Opyn v2. With these templates, anyone can create custom vaults with different strategies and open up for users to invest. 

## Documentation 

We reccomend starting out by reading the [documentation](https://opyn.gitbook.io/perp-vault/)

## Install

```
npm install
```

add a `.secret` file containing your testing mnemonic in the current folder.

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