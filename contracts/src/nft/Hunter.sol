// SPDX-License-Identifier: MIT
pragma solidity 0.8.24;

import {ERC721} from "@openzeppelin/contracts/token/ERC721/ERC721.sol";
import {ERC721Enumerable} from "@openzeppelin/contracts/token/ERC721/extensions/ERC721Enumerable.sol";
import {Ownable} from "@openzeppelin/contracts/access/Ownable.sol";
import {Base64} from "@openzeppelin/contracts/utils/Base64.sol";
import {Strings} from "@openzeppelin/contracts/utils/Strings.sol";

/// @notice The Whitespace bug-bounty reward collection. One unique, sequentially numbered NFT
///         per hunter, hard-capped at {MAX_SUPPLY}. Minting is owner-only: the owner holds the
///         badges and hands them to researchers who report a valid bug.
///
/// @dev    Art and metadata are generated fully on-chain (see {tokenURI}) so the collection
///         needs no IPFS pin or metadata server — it keeps rendering for as long as the chain
///         exists. There is no `baseURI` to set and nothing off-chain to keep alive.
///
///         {ERC721Enumerable} is mixed in so a frontend can list a wallet's badges straight
///         from the chain — `balanceOf` then `tokenOfOwnerByIndex` — without an indexer.
///
///         Token ids run 0..{MAX_SUPPLY}-1 in mint order; {totalMinted} is the next id and the
///         count minted so far. The cap is enforced on every mint path, so the collection can
///         never exceed {MAX_SUPPLY} holders.
contract Hunter is ERC721, ERC721Enumerable, Ownable {
    using Strings for uint256;

    /// @notice The collection can never mint more than this many tokens.
    uint256 public constant MAX_SUPPLY = 100;

    /// @notice Tokens minted so far, and the id the next mint will use. Never decreases (there
    ///         is no burn), so it is the stable serial source even though {totalSupply} happens
    ///         to equal it today.
    uint256 public totalMinted;

    /// @notice A mint would push the collection past {MAX_SUPPLY}.
    error MaxSupplyReached();

    /// @notice A batch/airdrop was called with nothing to mint.
    error EmptyBatch();

    constructor(address initialOwner) ERC721("Hunter", "HUNT") Ownable(initialOwner) {}

    /// @notice Mint one badge to `to`. Returns the id assigned.
    function mint(address to) external onlyOwner returns (uint256 tokenId) {
        if (totalMinted >= MAX_SUPPLY) revert MaxSupplyReached();
        return _mintOne(to);
    }

    /// @notice Mint `quantity` badges to a single address — the owner seeding its own wallet
    ///         with a stock of badges to hand out later.
    function mintBatch(address to, uint256 quantity) external onlyOwner {
        if (quantity == 0) revert EmptyBatch();
        if (totalMinted + quantity > MAX_SUPPLY) revert MaxSupplyReached();
        for (uint256 i; i < quantity; ++i) {
            _mintOne(to);
        }
    }

    /// @notice Mint one badge to each address in `recipients` — reward several hunters in one tx.
    function airdrop(address[] calldata recipients) external onlyOwner {
        if (recipients.length == 0) revert EmptyBatch();
        if (totalMinted + recipients.length > MAX_SUPPLY) revert MaxSupplyReached();
        for (uint256 i; i < recipients.length; ++i) {
            _mintOne(recipients[i]);
        }
    }

    /// @notice Badges still mintable before the collection is exhausted.
    function remaining() external view returns (uint256) {
        return MAX_SUPPLY - totalMinted;
    }

    /// @dev Assigns the next sequential id and mints it. Every caller bounds the mint against
    ///      {MAX_SUPPLY} first (the batch paths check the whole requested amount before their
    ///      loop), so the cap is never checked per-iteration. `_safeMint` rejects a contract
    ///      recipient that cannot receive ERC-721s, so a badge is never stranded.
    function _mintOne(address to) internal returns (uint256 tokenId) {
        tokenId = totalMinted;
        totalMinted = tokenId + 1;
        _safeMint(to, tokenId);
    }

    /// @notice On-chain metadata: a base64 `application/json` data URI whose `image` is a base64
    ///         SVG data URI. Everything is generated here, so nothing is hosted off-chain.
    function tokenURI(uint256 tokenId) public view override returns (string memory) {
        _requireOwned(tokenId);
        string memory json = _tokenJSON(tokenId);
        return string.concat("data:application/json;base64,", Base64.encode(bytes(json)));
    }

    /// @dev The ERC-721 metadata JSON for `tokenId`, before base64 wrapping.
    function _tokenJSON(uint256 tokenId) internal pure returns (string memory) {
        string memory id = tokenId.toString();
        string memory image = string.concat("data:image/svg+xml;base64,", Base64.encode(bytes(_tokenSVG(tokenId))));
        return string.concat(
            '{"name":"Hunter #',
            id,
            '","description":"Whitespace bug-bounty reward. Awarded to a security researcher for a valid report. Limited to 100.",',
            '"image":"',
            image,
            '","attributes":[',
            '{"trait_type":"Collection","value":"Hunter"},',
            '{"trait_type":"Serial","value":',
            id,
            '},{"trait_type":"Max Supply","value":100}]}'
        );
    }

    /// @dev A self-contained crosshair badge. SVG attributes use single quotes so the markup
    ///      embeds in the JSON (and in a `data:` URI) without any escaping.
    function _tokenSVG(uint256 tokenId) internal pure returns (string memory) {
        return string.concat(
            "<svg xmlns='http://www.w3.org/2000/svg' width='400' height='400' viewBox='0 0 400 400'>",
            "<defs><radialGradient id='g' cx='50%' cy='36%' r='80%'>",
            "<stop offset='0%' stop-color='#13203a'/><stop offset='100%' stop-color='#070b12'/>",
            "</radialGradient></defs>",
            "<rect width='400' height='400' fill='url(#g)'/>",
            "<rect x='14' y='14' width='372' height='372' rx='22' fill='none' stroke='#1f6feb' stroke-opacity='0.35' stroke-width='1.5'/>",
            "<circle cx='200' cy='168' r='72' fill='none' stroke='#58a6ff' stroke-width='3'/>",
            "<circle cx='200' cy='168' r='42' fill='none' stroke='#58a6ff' stroke-opacity='0.55' stroke-width='2'/>",
            "<circle cx='200' cy='168' r='5' fill='#58a6ff'/>",
            "<line x1='200' y1='78' x2='200' y2='120' stroke='#58a6ff' stroke-width='3'/>",
            "<line x1='200' y1='216' x2='200' y2='258' stroke='#58a6ff' stroke-width='3'/>",
            "<line x1='110' y1='168' x2='152' y2='168' stroke='#58a6ff' stroke-width='3'/>",
            "<line x1='248' y1='168' x2='290' y2='168' stroke='#58a6ff' stroke-width='3'/>",
            "<text x='200' y='312' text-anchor='middle' font-family='monospace' font-size='40' font-weight='700' fill='#e6edf3' letter-spacing='6'>HUNTER</text>",
            "<text x='200' y='344' text-anchor='middle' font-family='monospace' font-size='18' fill='#58a6ff'>#",
            tokenId.toString(),
            "</text>",
            "<text x='200' y='373' text-anchor='middle' font-family='monospace' font-size='11' fill='#8b949e' letter-spacing='2'>WHITESPACE BUG BOUNTY</text>",
            "</svg>"
        );
    }

    // --- required multiple-inheritance overrides (ERC721 + ERC721Enumerable) --------------

    function _update(address to, uint256 tokenId, address auth)
        internal
        override(ERC721, ERC721Enumerable)
        returns (address)
    {
        return super._update(to, tokenId, auth);
    }

    function _increaseBalance(address account, uint128 value) internal override(ERC721, ERC721Enumerable) {
        super._increaseBalance(account, value);
    }

    function supportsInterface(bytes4 interfaceId) public view override(ERC721, ERC721Enumerable) returns (bool) {
        return super.supportsInterface(interfaceId);
    }
}
