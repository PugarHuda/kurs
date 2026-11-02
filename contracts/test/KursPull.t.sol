// SPDX-License-Identifier: MIT
pragma solidity ^0.8.24;

import {Test} from "forge-std/Test.sol";
import {KursOracle} from "../src/KursOracle.sol";
import {KursConverter} from "../src/KursConverter.sol";

/// ERC-7412 pull flow: stale -> OracleDataRequired -> fulfillOracleQuery -> consumer succeeds.
contract KursPullTest is Test {
    KursOracle oracle;
    KursConverter converter;
    uint256[] keys;
    bytes32 constant IDR = keccak256("USD/IDR");

    event RoundUpdated(
        bytes32 indexed feedId,
        uint80 indexed roundId,
        int192 answer,
        uint64 observedAt,
        uint32 signerBitmap,
        address transmitter
    );

    function setUp() public {
        vm.warp(1_800_000_000);
        address[] memory reps = new address[](3);
        for (uint256 i; i < 3; ++i) {
            keys.push(0xB0B + i);
            reps[i] = vm.addr(0xB0B + i);
        }
        oracle = new KursOracle(reps, 2);
        oracle.setFeed(IDR, "USD / IDR", 8, 3600, 100, 1_000e8, 100_000e8);
        converter = new KursConverter(oracle, IDR, 60);
    }

    function _payload(uint80 round, int192 price, uint64 at) internal view returns (bytes memory) {
        KursOracle.Observation[] memory obs = new KursOracle.Observation[](3);
        for (uint256 i; i < 3; ++i) {
            (uint8 v, bytes32 r, bytes32 s) = vm.sign(keys[i], oracle.observationDigest(IDR, round, price, at));
            obs[i] = KursOracle.Observation(price, at, v, r, s);
        }
        return abi.encode(IDR, round, obs);
    }

    function test_oracleId() public view {
        assertEq(oracle.oracleId(), bytes32("KURS"));
    }

    function test_noDataRequiresPull() public {
        vm.expectRevert(
            abi.encodeWithSelector(KursOracle.OracleDataRequired.selector, address(oracle), abi.encode(IDR, uint32(60)))
        );
        converter.convert(100_00);
    }

    function test_pullThenConvert() public {
        bytes memory payload = _payload(10, 18_150e8, uint64(block.timestamp - 5));
        vm.expectEmit(true, true, false, true, address(oracle));
        emit RoundUpdated(IDR, 10, 18_150e8, uint64(block.timestamp - 5), 7, address(this));
        oracle.fulfillOracleQuery(payload);
        assertEq(converter.convert(100_00), 1_815_000_00); // $100.00 -> Rp1,815,000.00
    }

    function test_staleRequiresPullAgain() public {
        oracle.fulfillOracleQuery(_payload(10, 18_150e8, uint64(block.timestamp)));
        vm.warp(block.timestamp + 61);
        vm.expectRevert(
            abi.encodeWithSelector(KursOracle.OracleDataRequired.selector, address(oracle), abi.encode(IDR, uint32(60)))
        );
        converter.convert(1);
    }

    function test_fulfillIsIdempotent() public {
        bytes memory payload = _payload(10, 18_150e8, uint64(block.timestamp));
        oracle.fulfillOracleQuery(payload);
        oracle.fulfillOracleQuery(payload); // second consumer with the same bundle: no revert
        assertEq(oracle.latestRoundId(IDR), 10);
    }

    function test_fulfillStillVerifiesSignatures() public {
        bytes memory payload = _payload(10, 18_150e8, uint64(block.timestamp));
        (bytes32 f, uint80 r, KursOracle.Observation[] memory obs) =
            abi.decode(payload, (bytes32, uint80, KursOracle.Observation[]));
        obs[0].answer = 99_000e8; // tamper
        vm.expectPartialRevert(KursOracle.UnknownReporter.selector);
        oracle.fulfillOracleQuery(abi.encode(f, r, obs));
    }

    function test_transmitStillRejectsReplay() public {
        bytes memory payload = _payload(10, 18_150e8, uint64(block.timestamp));
        oracle.fulfillOracleQuery(payload);
        (,, KursOracle.Observation[] memory obs) = abi.decode(payload, (bytes32, uint80, KursOracle.Observation[]));
        vm.expectRevert(abi.encodeWithSelector(KursOracle.StaleRound.selector, 10, 10));
        this.callTransmit(obs);
    }

    function callTransmit(KursOracle.Observation[] calldata obs) external {
        oracle.transmit(IDR, 10, obs);
    }
}
