// SPDX-License-Identifier: MIT
pragma solidity 0.8.24;

import {ERC20} from "@openzeppelin/contracts/token/ERC20/ERC20.sol";
import {Ownable} from "@openzeppelin/contracts/access/Ownable.sol";

/// @notice Testnet-only collateral asset. Six decimals to match the USDC that the
///         vendored Ostium contracts expect. Never deploy this to mainnet.
contract USDW is ERC20, Ownable {
    uint256 public constant FAUCET_AMOUNT = 1_000e6;
    uint256 public constant FAUCET_COOLDOWN = 1 days;

    mapping(address => uint256) public lastClaim;

    error CooldownActive(uint256 availableAt);

    constructor(address initialOwner) ERC20("Whitespace USD", "USDW") Ownable(initialOwner) {}

    function decimals() public pure override returns (uint8) {
        return 6;
    }

    /// @notice Mint the faucet amount to the caller, at most once per cooldown period.
    function claim() external {
        uint256 previous = lastClaim[msg.sender];
        if (previous != 0 && block.timestamp < previous + FAUCET_COOLDOWN) {
            revert CooldownActive(previous + FAUCET_COOLDOWN);
        }
        lastClaim[msg.sender] = block.timestamp;
        _mint(msg.sender, FAUCET_AMOUNT);
    }

    /// @notice Owner mint, for seeding the LP vault and test accounts.
    function mint(address to, uint256 amount) external onlyOwner {
        _mint(to, amount);
    }
}
