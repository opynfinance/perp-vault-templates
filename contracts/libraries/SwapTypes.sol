// SPDX-License-Identifier: Apache
/*
  Copyright 2020 Swap Holdings Ltd.

  Licensed under the Apache License, Version 2.0 (the "License");
  you may not use this file except in compliance with the License.
  You may obtain a copy of the License at

    http://www.apache.org/licenses/LICENSE-2.0

  Unless required by applicable law or agreed to in writing, software
  distributed under the License is distributed on an "AS IS" BASIS,
  WITHOUT WARRANTIES OR CONDITIONS OF ANY KIND, either express or implied.
  See the License for the specific language governing permissions and
  limitations under the License.
*/

pragma solidity ^0.7.2;
pragma experimental ABIEncoderV2;

import "hardhat/console.sol";


/**
 * @title Types: Library of Swap Protocol Types and Hashes
 */
library SwapTypes {
    struct Order {
        uint256 nonce; // Unique per order and should be sequential
        uint256 expiry; // Expiry in seconds since 1 January 1970
        Signer signer; // Party to the trade that sets terms
        Sender sender; // Party to the trade that accepts terms
        Signer affiliate; // Party compensated for facilitating (optional)
        Signature signature; // Signature of the order
    }

    struct Signer {
        address wallet; // Wallet address of the party
        address token; // Contract address of the token
        uint256 amount; // Amount for ERC-20 or ERC-1155
    }

    struct Sender {
        address wallet; // Wallet address of the party
        address lowerToken; // Contract address of the token
        address higherToken; // Contract address of the token
        uint256 amount; // Amount for ERC-20 or ERC-1155
    }

    struct Signature {
        address signatory; // Address of the wallet used to sign
        address validator; // Address of the intended swap contract
        bytes1 version; // EIP-191 signature version
        uint8 v; // `v` value of an ECDSA signature
        bytes32 r; // `r` value of an ECDSA signature
        bytes32 s; // `s` value of an ECDSA signature
    }

}
