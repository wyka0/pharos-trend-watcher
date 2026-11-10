// SPDX-License-Identifier: MIT
pragma solidity ^0.8.24;

/**
 * @title TrendAnchor
 * @notice On-chain Proof-of-Trend registry for the Pharos Trend Watcher skill
 *         (Pharos Atlantic Testnet, chainId 688689).
 *
 * When the watcher's multi-observation trend rule fires (>= 3 consecutive
 * directional checks — never a single spike), it anchors the exact evidence
 * on-chain:
 *   - ruleHash          keccak256(canonical JSON of the TrendRule)
 *   - proofDigest       keccak256(abi.encode(ruleHash, windowObservationHashes[]))
 *   - windowObservationHashes[]  the hash-chained observations that authorized
 *                                the agent to act (Innovation 1).
 *
 * Each (proofDigest) can only be anchored once, making the trigger moment a
 * unique, auditable on-chain receipt: hash_i = keccak256(hash_{i-1},
 * blockNumber_i, value_i, observationId_i) links every window element back to
 * the very first observation the watcher ever stored on disk.
 */
contract TrendAnchor {
    struct Proof {
        address watcher;      // account that executed the protective action
        bytes32 ruleHash;     // which rule authorized the action
        bytes32 proofDigest;  // keccak256(ruleHash, windowObservationHashes[])
        uint256 triggerIndex; // observation index at which the rule fired
        uint64 blockNumber;   // chain block at anchoring time
        uint64 timestamp;     // chain time at anchoring time
    }

    mapping(bytes32 => Proof) public proofs;
    uint256 public totalAnchored;

    event TrendAnchored(
        bytes32 indexed proofDigest,
        bytes32 indexed ruleHash,
        address indexed watcher,
        uint256 triggerIndex,
        bytes32[] windowObservationHashes,
        uint64 blockNumber,
        uint64 timestamp
    );

    error AlreadyAnchored();
    error EmptyWindow();

    function anchor(
        bytes32 ruleHash,
        bytes32 proofDigest,
        uint256 triggerIndex,
        bytes32[] calldata windowObservationHashes
    ) external {
        if (windowObservationHashes.length < 3) revert EmptyWindow(); // >= 3 observations always
        if (proofs[proofDigest].timestamp != 0) revert AlreadyAnchored();
        proofs[proofDigest] = Proof(
            msg.sender,
            ruleHash,
            proofDigest,
            triggerIndex,
            uint64(block.number),
            uint64(block.timestamp)
        );
        unchecked { ++totalAnchored; }
        emit TrendAnchored(
            proofDigest,
            ruleHash,
            msg.sender,
            triggerIndex,
            windowObservationHashes,
            uint64(block.number),
            uint64(block.timestamp)
        );
    }

    function getProof(bytes32 proofDigest) external view returns (Proof memory) {
        return proofs[proofDigest];
    }

    // NOTE: flat getters — some testnet EVM implementations mishandle struct
    // returns on eth_call; simple-type views are Pharos-safe.
    function getProofWatcher(bytes32 proofDigest) external view returns (address) {
        return proofs[proofDigest].watcher;
    }

    function getProofRuleHash(bytes32 proofDigest) external view returns (bytes32) {
        return proofs[proofDigest].ruleHash;
    }

    function getProofTriggerIndex(bytes32 proofDigest) external view returns (uint256) {
        return proofs[proofDigest].triggerIndex;
    }

    function getProofBlockNumber(bytes32 proofDigest) external view returns (uint64) {
        return proofs[proofDigest].blockNumber;
    }

    function isAnchored(bytes32 proofDigest) external view returns (bool) {
        return proofs[proofDigest].timestamp != 0;
    }
}
