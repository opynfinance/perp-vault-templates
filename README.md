# @stakedao/opyn-perp-vault

StakeDaoPerpVault Solidity smart contracts


## Prerequisites

- [NodeJS](https://nodejs.org/en/)
  -  v12.22.4 <=

## Installation

To install all necessary dependencies, from project root run:

```shell
npm ci
```

add a `.secret` file containing your testing mnemonic at the project root folder.

## Compiling contracts

To compile the contracts, from project root run:

```shell
npm run compile
```

## Testing contracts

To test the contracts, from project root run the following:

### Running unit tests

```shell
npm run test
```

### Mainnet fork test

```shell
npm run test:fork
```

## Coverage

Generate test coverage report

```shell
npm run test:coverage
```
