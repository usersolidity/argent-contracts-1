// SPDX-License-Identifier: GPL-3.0-only
pragma solidity ^0.6.12;

import "@openzeppelin/contracts/token/ERC721/ERC721.sol";

contract TestERC721 is ERC721 {
    constructor() ERC721("Argent Kitties", "AGKT") public {
    }

    function mint(address to, uint256 tokenId) public {
        _mint(to, tokenId);
    }
}
