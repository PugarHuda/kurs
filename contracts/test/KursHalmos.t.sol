// SPDX-License-Identifier: MIT
pragma solidity ^0.8.24;

import {Test} from "forge-std/Test.sol";
import {KursOracle} from "../src/KursOracle.sol";

/// Exposes the oracle's own _sort and _median, unchanged.
contract MedianHarness is KursOracle {
    constructor(address[] memory r) KursOracle(r, 1) {}

    function sortAndMedian(int192[] memory a) external pure returns (int192[] memory, int192) {
        _sort(a);
        return (a, _median(a));
    }
}

/// Symbolic proofs, run by Halmos (`halmos --match-contract KursHalmos`): every check_
/// holds for ALL int192 inputs, not a fuzzed sample. Bundle sizes 3, 4 and 5 cover the
/// deployed configuration (5 reporters, quorum 3). forge test skips check_ functions.
contract KursHalmos is Test {
    MedianHarness h;

    function setUp() public {
        address[] memory r = new address[](1);
        r[0] = address(0xA11CE);
        h = new MedianHarness(r);
    }

    function _arr(int192 a, int192 b, int192 c, int192 d, int192 e, uint256 n) internal pure returns (int192[] memory x) {
        x = new int192[](n);
        x[0] = a;
        x[1] = b;
        x[2] = c;
        if (n > 3) x[3] = d;
        if (n > 4) x[4] = e;
    }

    /// The sort is ascending and a permutation (every element keeps its multiplicity).
    function _checkSort(int192[] memory input) internal view {
        (int192[] memory s,) = h.sortAndMedian(_copy(input));
        for (uint256 i = 1; i < s.length; ++i) assert(s[i - 1] <= s[i]);
        for (uint256 i; i < input.length; ++i) assert(_count(s, input[i]) == _count(input, input[i]));
    }

    /// The median lies between the smallest and the largest observation.
    function _checkBounded(int192[] memory input) internal view {
        (, int192 m) = h.sortAndMedian(_copy(input));
        // ponytail: "m >= some input and m <= some input" == bounded, without min/max branches
        bool geSome;
        bool leSome;
        for (uint256 i; i < input.length; ++i) {
            int192 v = input[i];
            assembly {
                geSome := or(geSome, iszero(slt(m, v)))
                leSome := or(leSome, iszero(sgt(m, v)))
            }
        }
        assert(geSome && leSome);
    }

    /// The oracle's core claim: if a strict majority of the bundle is honest and their
    /// values lie in [lo, hi], the median is in [lo, hi] whatever the minority signs.
    /// Honest values sit at positions 0..k-1; the sort makes position irrelevant.
    function _checkMinority(int192[] memory input, uint256 honest, int192 lo, int192 hi) internal view {
        for (uint256 i; i < honest; ++i) vm.assume(lo <= input[i] && input[i] <= hi);
        (, int192 m) = h.sortAndMedian(_copy(input));
        assert(lo <= m && m <= hi);
    }

    function check_sort3(int192 a, int192 b, int192 c) public view {
        _checkSort(_arr(a, b, c, 0, 0, 3));
    }

    function check_sort4(int192 a, int192 b, int192 c, int192 d) public view {
        _checkSort(_arr(a, b, c, d, 0, 4));
    }

    function check_sort5(int192 a, int192 b, int192 c, int192 d, int192 e) public view {
        _checkSort(_arr(a, b, c, d, e, 5));
    }

    function check_medianBounded3(int192 a, int192 b, int192 c) public view {
        _checkBounded(_arr(a, b, c, 0, 0, 3));
    }

    function check_medianBounded4(int192 a, int192 b, int192 c, int192 d) public view {
        _checkBounded(_arr(a, b, c, d, 0, 4));
    }

    function check_medianBounded5(int192 a, int192 b, int192 c, int192 d, int192 e) public view {
        _checkBounded(_arr(a, b, c, d, e, 5));
    }

    /// 3 observations, 2 honest, 1 lying
    function check_minority3(int192 a, int192 b, int192 c, int192 lo, int192 hi) public view {
        _checkMinority(_arr(a, b, c, 0, 0, 3), 2, lo, hi);
    }

    /// 4 observations, 3 honest, 1 lying (even count: mean of the middle two)
    function check_minority4(int192 a, int192 b, int192 c, int192 d, int192 lo, int192 hi) public view {
        _checkMinority(_arr(a, b, c, d, 0, 4), 3, lo, hi);
    }

    /// 5 observations, 3 honest, 2 lying: the deployed quorum
    function check_minority5(int192 a, int192 b, int192 c, int192 d, int192 e, int192 lo, int192 hi) public view {
        _checkMinority(_arr(a, b, c, d, e, 5), 3, lo, hi);
    }

    function _copy(int192[] memory a) internal pure returns (int192[] memory b) {
        b = new int192[](a.length);
        for (uint256 i; i < a.length; ++i) b[i] = a[i];
    }

    function _count(int192[] memory a, int192 v) internal pure returns (uint256 n) {
        // branch-free so Halmos does not fork 2^n paths per call
        for (uint256 i; i < a.length; ++i) {
            int192 x = a[i];
            assembly {
                n := add(n, eq(x, v))
            }
        }
    }
}
