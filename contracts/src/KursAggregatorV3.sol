// SPDX-License-Identifier: MIT
pragma solidity ^0.8.24;

import {KursOracle} from "./KursOracle.sol";

/// @notice Chainlink AggregatorV3Interface shape, so existing DeFi code
/// (lending markets, vaults, perps) reads Kurs without changes.
interface AggregatorV3Interface {
    function decimals() external view returns (uint8);
    function description() external view returns (string memory);
    function version() external view returns (uint256);
    function getRoundData(uint80 roundId)
        external
        view
        returns (uint80 roundId_, int256 answer, uint256 startedAt, uint256 updatedAt, uint80 answeredInRound);
    function latestRoundData()
        external
        view
        returns (uint80 roundId, int256 answer, uint256 startedAt, uint256 updatedAt, uint80 answeredInRound);
}

/// @title KursAggregatorV3
/// @notice Read-only AggregatorV3 view of one Kurs feed.
/// startedAt = oldest reporter observation, updatedAt = local block time.
/// Deployed once as an implementation; every feed gets a 45-byte EIP-1167
/// clone from KursAggregatorFactory, because pallet-revive charges a deposit
/// per byte of code and a full copy per feed would cost ~150 tPOT each.
contract KursAggregatorV3 is AggregatorV3Interface {
    KursOracle public oracle;
    bytes32 public feedId;

    error NoData();
    error AlreadyInitialized();

    /// Direct deployment initialises immediately; the implementation behind
    /// clones is deployed with oracle_ = 0 and never initialised.
    constructor(KursOracle oracle_, bytes32 feedId_) {
        if (address(oracle_) != address(0)) initialize(oracle_, feedId_);
    }

    function initialize(KursOracle oracle_, bytes32 feedId_) public {
        if (address(oracle) != address(0)) revert AlreadyInitialized();
        oracle = oracle_;
        feedId = feedId_;
    }

    function decimals() external view returns (uint8) {
        return oracle.feed(feedId).decimals;
    }

    function description() external view returns (string memory) {
        return oracle.feed(feedId).description;
    }

    function version() external pure returns (uint256) {
        return 1;
    }

    function getRoundData(uint80 roundId) public view returns (uint80, int256, uint256, uint256, uint80) {
        KursOracle.Round memory r = oracle.getRound(feedId, roundId);
        if (r.updatedAt == 0) revert NoData();
        return (roundId, r.answer, r.observedAt, r.updatedAt, roundId);
    }

    function latestRoundData() external view returns (uint80, int256, uint256, uint256, uint80) {
        return getRoundData(oracle.latestRoundId(feedId));
    }
}

/// @title KursAggregatorFactory
/// @notice Deploys one EIP-1167 clone of KursAggregatorV3 per feed.
contract KursAggregatorFactory {
    address public immutable implementation;
    KursOracle public immutable oracle;
    mapping(bytes32 => address) public aggregatorOf;

    event AggregatorDeployed(bytes32 indexed feedId, address aggregator);

    error Exists(address aggregator);
    error CloneFailed();

    constructor(KursOracle oracle_) {
        oracle = oracle_;
        implementation = address(new KursAggregatorV3(KursOracle(address(0)), bytes32(0)));
    }

    /// Permissionless: the clone is a read-only view, the oracle decides what it shows.
    function deploy(bytes32 feedId) external returns (address agg) {
        if (aggregatorOf[feedId] != address(0)) revert Exists(aggregatorOf[feedId]);
        address impl = implementation;
        assembly ("memory-safe") {
            let p := mload(0x40)
            mstore(p, 0x3d602d80600a3d3981f3363d3d373d3d3d363d73000000000000000000000000)
            mstore(add(p, 0x14), shl(0x60, impl))
            mstore(add(p, 0x28), 0x5af43d82803e903d91602b57fd5bf30000000000000000000000000000000000)
            agg := create2(0, p, 0x37, feedId)
        }
        if (agg == address(0)) revert CloneFailed();
        KursAggregatorV3(agg).initialize(oracle, feedId);
        aggregatorOf[feedId] = agg;
        emit AggregatorDeployed(feedId, agg);
    }
}
