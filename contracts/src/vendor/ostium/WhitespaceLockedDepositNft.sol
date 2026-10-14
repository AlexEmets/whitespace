// SPDX-License-Identifier: MIT
import '@openzeppelin/contracts/token/ERC721/extensions/ERC721Enumerable.sol';

import './interfaces/IWhitespaceRegistry.sol';
import './interfaces/IWhitespaceLockedDepositNft.sol';

pragma solidity ^0.8.24;

contract WhitespaceLockedDepositNft is IWhitespaceLockedDepositNft, ERC721Enumerable {
    IWhitespaceRegistry immutable registry;

    constructor(string memory name, string memory symbol, IWhitespaceRegistry _registry) ERC721(name, symbol) {
        registry = _registry;
    }

    modifier onlyVault() {
        _onlyVault(msg.sender);
        _;
    }

    function _onlyVault(address a) private view {
        if (a != registry.getContractAddress('vault')) {
            revert NotVault(msg.sender);
        }
    }

    function mint(address to, uint256 tokenId) external onlyVault {
        _safeMint(to, tokenId);
    }

    function burn(uint256 tokenId) external onlyVault {
        _burn(tokenId);
    }
}

