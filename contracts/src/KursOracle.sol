// SPDX-License-Identifier: MIT
pragma solidity ^0.8.24;

/// @title KursOracle
/// @notice Signed-observation price oracle for Portaldot V3 (pallet-revive EVM).
///
/// Every reporter signs its own observation (EIP-712). Anyone can transmit a
/// bundle of observations; the contract checks each signature, requires a
/// quorum of distinct reporters, rejects bundles whose reporters disagree by
/// more than the feed's max spread, and stores the on-chain median.
///
/// The EIP-712 domain deliberately carries no chainId and no verifyingContract:
/// the same signed bundle verifies on Portaldot and on any EVM chain running
/// this contract with the same reporter set. That is what makes Kurs a data
/// bridge rather than a single-chain oracle. Replay inside one chain is
/// prevented because a feed only accepts a roundId above its latest one, and
/// re-submitting a bundle on another chain is the intended relay path.
///
/// Push and pull: a relayer can push rounds with `transmit`, and a consumer can
/// pull a fresh signed bundle into its own transaction through ERC-7412
/// (`latestRoundFresh` reverts `OracleDataRequired`, the client fetches a bundle
/// and calls `fulfillOracleQuery` in the same multicall).
contract KursOracle {
    // ---------------------------------------------------------------- types

    struct Feed {
        uint8 decimals;
        uint16 maxSpreadBps; // max (high - low) / median across one bundle
        uint32 heartbeat; // seconds; informational for consumers + dashboard
        int192 minAnswer; // circuit breaker bounds
        int192 maxAnswer;
        bool exists;
        string description; // e.g. "ETH / USD"
    }

    struct Round {
        int192 answer;
        uint64 observedAt; // oldest observation timestamp in the bundle (conservative)
        uint64 updatedAt; // block.timestamp on this chain
        uint32 signerBitmap; // which reporter slots signed (bit i = slot i)
        uint80 roundId; // lets a ring-buffer slot prove which round it holds
    }

    struct Observation {
        int192 answer;
        uint64 observedAt;
        uint8 v;
        bytes32 r;
        bytes32 s;
    }

    // ------------------------------------------------------------- constants

    uint256 public constant MAX_REPORTERS = 31;
    /// Rounds kept per feed. pallet-revive charges a storage deposit for every
    /// new slot, so history is a ring buffer: after warm-up a round overwrites
    /// an old slot and costs no new deposit.
    uint80 public constant HISTORY = 64;
    bytes32 public constant OBSERVATION_TYPEHASH =
        keccak256("Observation(bytes32 feedId,uint80 roundId,int192 answer,uint64 observedAt)");
    bytes32 public immutable DOMAIN_SEPARATOR;

    // ----------------------------------------------------------------- state

    address public owner;
    address public pendingOwner;

    address[] internal _reporters;
    mapping(address => uint8) public reporterSlot; // slot + 1; 0 = not a reporter
    uint8 public quorum;
    uint32 public configVersion;

    /// Observations older than this (relative to block.timestamp) are rejected.
    uint32 public maxObservationAge = 1 hours;
    /// Observations further in the future than this are rejected (clock skew).
    uint32 public constant MAX_FUTURE_SKEW = 5 minutes;

    bytes32[] internal _feedIds;
    mapping(bytes32 => Feed) internal _feeds;
    mapping(bytes32 => uint80) public latestRoundId;
    mapping(bytes32 => mapping(uint256 => Round)) internal _rounds; // feedId => roundId % HISTORY => Round

    // ---------------------------------------------------------------- events

    event OwnershipTransferStarted(address indexed previousOwner, address indexed newOwner);
    event OwnershipTransferred(address indexed previousOwner, address indexed newOwner);
    event ReportersSet(uint32 indexed configVersion, address[] reporters, uint8 quorum);
    event FeedSet(bytes32 indexed feedId, string description, uint8 decimals);
    event MaxObservationAgeSet(uint32 maxObservationAge);
    event RoundUpdated(
        bytes32 indexed feedId,
        uint80 indexed roundId,
        int192 answer,
        uint64 observedAt,
        uint32 signerBitmap,
        address transmitter
    );

    // ---------------------------------------------------------------- errors

    error NotOwner();
    error NotPendingOwner();
    error UnknownFeed(bytes32 feedId);
    error StaleRound(uint80 roundId, uint80 latest);
    error NotEnoughObservations(uint256 got, uint8 quorum);
    error TooManyObservations(uint256 got);
    error BadSignature(uint256 index);
    error UnknownReporter(address signer);
    error DuplicateReporter(address signer);
    error ObservationTooOld(uint256 index, uint64 observedAt);
    error ObservationInFuture(uint256 index, uint64 observedAt);
    error ReportersDisagree(int192 low, int192 high, int192 median);
    error AnswerOutOfBounds(int192 answer);
    error BadConfig();
    /// ERC-7412: the caller needs fresher data. oracleQuery = abi.encode(feedId, maxAge).
    error OracleDataRequired(address oracleContract, bytes oracleQuery);

    // ------------------------------------------------------------ modifiers

    modifier onlyOwner() {
        if (msg.sender != owner) revert NotOwner();
        _;
    }

    constructor(address[] memory reporters, uint8 quorum_) {
        owner = msg.sender;
        emit OwnershipTransferred(address(0), msg.sender);
        DOMAIN_SEPARATOR = keccak256(
            abi.encode(keccak256("EIP712Domain(string name,string version)"), keccak256("Kurs"), keccak256("1"))
        );
        _setReporters(reporters, quorum_);
    }

    // ------------------------------------------------------------ transmit

    /// @notice Submit a signed bundle for one round of one feed.
    /// @dev Permissionless: security comes from the signatures, not the caller.
    function transmit(bytes32 feedId, uint80 roundId, Observation[] calldata obs) external {
        uint80 latest = latestRoundId[feedId];
        if (roundId <= latest) revert StaleRound(roundId, latest);
        _transmit(feedId, roundId, obs);
    }

    // ------------------------------------------------------------ ERC-7412 (pull)

    /// @notice ERC-7412 oracle id.
    function oracleId() external pure returns (bytes32) {
        return bytes32("KURS");
    }

    /// @notice ERC-7412: accept a signed bundle pulled by the consumer's client.
    /// signedOffchainData = abi.encode(bytes32 feedId, uint80 roundId, Observation[] obs).
    /// Idempotent: if this round or a newer one is already on chain (another
    /// consumer pulled it first), it returns instead of reverting, so a batched
    /// consumer call that follows still succeeds.
    function fulfillOracleQuery(bytes calldata signedOffchainData) external payable {
        (bytes32 feedId, uint80 roundId, Observation[] memory obs) =
            abi.decode(signedOffchainData, (bytes32, uint80, Observation[]));
        if (roundId <= latestRoundId[feedId]) return;
        _transmit(feedId, roundId, obs);
    }

    /// @notice Latest round, or revert ERC-7412 OracleDataRequired when the newest
    /// observation is older than `maxAge` seconds (or the feed has no data yet).
    function latestRoundFresh(bytes32 feedId, uint32 maxAge)
        external
        view
        returns (uint80 roundId, int192 answer, uint64 observedAt, uint64 updatedAt)
    {
        if (!_feeds[feedId].exists) revert UnknownFeed(feedId);
        roundId = latestRoundId[feedId];
        Round storage r = _rounds[feedId][roundId % HISTORY];
        if (roundId == 0 || r.observedAt + maxAge < block.timestamp) {
            revert OracleDataRequired(address(this), abi.encode(feedId, maxAge));
        }
        return (roundId, r.answer, r.observedAt, r.updatedAt);
    }

    function _transmit(bytes32 feedId, uint80 roundId, Observation[] memory obs) internal {
        Feed storage feed = _feeds[feedId];
        if (!feed.exists) revert UnknownFeed(feedId);

        (int192[] memory answers, uint32 bitmap, uint64 oldest) = _verify(feedId, roundId, obs);
        int192 median = _checkAndMedian(feed, answers);

        latestRoundId[feedId] = roundId;
        _rounds[feedId][roundId % HISTORY] = Round({
            answer: median,
            observedAt: oldest,
            updatedAt: uint64(block.timestamp),
            signerBitmap: bitmap,
            roundId: roundId
        });

        emit RoundUpdated(feedId, roundId, median, oldest, bitmap, msg.sender);
    }

    /// @notice EIP-712 digest a reporter signs for one observation.
    function observationDigest(bytes32 feedId, uint80 roundId, int192 answer, uint64 observedAt)
        public
        view
        returns (bytes32)
    {
        bytes32 structHash = keccak256(abi.encode(OBSERVATION_TYPEHASH, feedId, roundId, answer, observedAt));
        return keccak256(abi.encodePacked("\x19\x01", DOMAIN_SEPARATOR, structHash));
    }

    // --------------------------------------------------------------- views

    function latestRound(bytes32 feedId)
        external
        view
        returns (uint80 roundId, int192 answer, uint64 observedAt, uint64 updatedAt)
    {
        if (!_feeds[feedId].exists) revert UnknownFeed(feedId);
        roundId = latestRoundId[feedId];
        Round storage r = _rounds[feedId][roundId % HISTORY];
        return (roundId, r.answer, r.observedAt, r.updatedAt);
    }

    /// @notice Returns an empty Round (updatedAt == 0) if the round never existed
    /// or has been overwritten by a round HISTORY rounds later.
    function getRound(bytes32 feedId, uint80 roundId) external view returns (Round memory r) {
        r = _rounds[feedId][roundId % HISTORY];
        if (r.roundId != roundId) delete r;
    }

    function feed(bytes32 feedId) external view returns (Feed memory) {
        return _feeds[feedId];
    }

    function feedIds() external view returns (bytes32[] memory) {
        return _feedIds;
    }

    function reporters() external view returns (address[] memory) {
        return _reporters;
    }

    /// @notice Convenience: feedId for a human pair name, e.g. "ETH/USD".
    function feedIdOf(string calldata pair) external pure returns (bytes32) {
        return keccak256(bytes(pair));
    }

    // --------------------------------------------------------------- admin

    function setReporters(address[] calldata reporters_, uint8 quorum_) external onlyOwner {
        _setReporters(reporters_, quorum_);
    }

    function setFeed(
        bytes32 feedId,
        string calldata description,
        uint8 decimals,
        uint32 heartbeat,
        uint16 maxSpreadBps,
        int192 minAnswer,
        int192 maxAnswer
    ) external onlyOwner {
        if (minAnswer > maxAnswer || maxSpreadBps == 0) revert BadConfig();
        Feed storage f = _feeds[feedId];
        if (!f.exists) _feedIds.push(feedId);
        f.exists = true;
        f.description = description;
        f.decimals = decimals;
        f.heartbeat = heartbeat;
        f.maxSpreadBps = maxSpreadBps;
        f.minAnswer = minAnswer;
        f.maxAnswer = maxAnswer;
        emit FeedSet(feedId, description, decimals);
    }

    function setMaxObservationAge(uint32 age) external onlyOwner {
        if (age == 0) revert BadConfig();
        maxObservationAge = age;
        emit MaxObservationAgeSet(age);
    }

    function transferOwnership(address newOwner) external onlyOwner {
        pendingOwner = newOwner;
        emit OwnershipTransferStarted(owner, newOwner);
    }

    function acceptOwnership() external {
        if (msg.sender != pendingOwner) revert NotPendingOwner();
        emit OwnershipTransferred(owner, msg.sender);
        owner = msg.sender;
        pendingOwner = address(0);
    }

    // ------------------------------------------------------------ internal

    /// Verifies freshness, signatures, membership and uniqueness of every observation.
    function _verify(bytes32 feedId, uint80 roundId, Observation[] memory obs)
        internal
        view
        returns (int192[] memory answers, uint32 bitmap, uint64 oldest)
    {
        uint256 n = obs.length;
        if (n < quorum) revert NotEnoughObservations(n, quorum);
        if (n > MAX_REPORTERS) revert TooManyObservations(n);

        answers = new int192[](n);
        oldest = type(uint64).max;
        for (uint256 i; i < n; ++i) {
            Observation memory o = obs[i];
            if (o.observedAt > block.timestamp + MAX_FUTURE_SKEW) revert ObservationInFuture(i, o.observedAt);
            if (o.observedAt + maxObservationAge < block.timestamp) revert ObservationTooOld(i, o.observedAt);

            address signer = _recover(observationDigest(feedId, roundId, o.answer, o.observedAt), o.v, o.r, o.s, i);
            uint8 slot = reporterSlot[signer];
            if (slot == 0) revert UnknownReporter(signer);
            uint32 bit = uint32(1) << (slot - 1);
            if (bitmap & bit != 0) revert DuplicateReporter(signer);
            bitmap |= bit;

            answers[i] = o.answer;
            if (o.observedAt < oldest) oldest = o.observedAt;
        }
    }

    /// Sorts, takes the median, then applies circuit-breaker bounds and the spread rule.
    function _checkAndMedian(Feed storage feed, int192[] memory answers) internal view returns (int192 median) {
        _sort(answers);
        median = _median(answers);
        if (median < feed.minAnswer || median > feed.maxAnswer) revert AnswerOutOfBounds(median);
        int192 low = answers[0];
        int192 high = answers[answers.length - 1];
        // (high - low) * 10_000 > maxSpreadBps * |median|  => reporters disagree
        int256 absMedian = median < 0 ? -int256(median) : int256(median);
        if ((int256(high) - int256(low)) * 10_000 > int256(uint256(feed.maxSpreadBps)) * absMedian) {
            revert ReportersDisagree(low, high, median);
        }
    }

    function _setReporters(address[] memory reporters_, uint8 quorum_) internal {
        uint256 n = reporters_.length;
        // quorum must be a strict majority so a minority cannot move the median
        if (n == 0 || n > MAX_REPORTERS || quorum_ == 0 || quorum_ > n || uint256(quorum_) * 2 <= n) {
            revert BadConfig();
        }
        for (uint256 i; i < _reporters.length; ++i) {
            reporterSlot[_reporters[i]] = 0;
        }
        delete _reporters;
        for (uint256 i; i < n; ++i) {
            address a = reporters_[i];
            if (a == address(0) || reporterSlot[a] != 0) revert BadConfig();
            reporterSlot[a] = uint8(i + 1);
            _reporters.push(a);
        }
        quorum = quorum_;
        unchecked {
            ++configVersion;
        }
        emit ReportersSet(configVersion, reporters_, quorum_);
    }

    function _recover(bytes32 digest, uint8 v, bytes32 r, bytes32 s, uint256 i) internal pure returns (address) {
        // reject malleable (high-s) signatures, EIP-2
        if (uint256(s) > 0x7FFFFFFFFFFFFFFFFFFFFFFFFFFFFFFF5D576E7357A4501DDFE92F46681B20A0) revert BadSignature(i);
        address signer = ecrecover(digest, v, r, s);
        if (signer == address(0)) revert BadSignature(i);
        return signer;
    }

    // insertion sort: n <= 31, cheaper than anything clever
    function _sort(int192[] memory a) internal pure {
        for (uint256 i = 1; i < a.length; ++i) {
            int192 key = a[i];
            uint256 j = i;
            while (j > 0 && a[j - 1] > key) {
                a[j] = a[j - 1];
                --j;
            }
            a[j] = key;
        }
    }

    function _median(int192[] memory sorted) internal pure returns (int192) {
        uint256 n = sorted.length;
        if (n % 2 == 1) return sorted[n / 2];
        return int192((int256(sorted[n / 2 - 1]) + int256(sorted[n / 2])) / 2);
    }
}
