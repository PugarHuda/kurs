// EIP-712 definitions shared by reporters, transmitters and the browser dashboard.
/** Must match KursOracle: name/version only, no chainId — the bundle is chain-portable. */
export const DOMAIN = { name: "Kurs", version: "1" } as const;
export const TYPES = {
  Observation: [
    { name: "feedId", type: "bytes32" },
    { name: "roundId", type: "uint80" },
    { name: "answer", type: "int192" },
    { name: "observedAt", type: "uint64" },
  ],
} as const;
