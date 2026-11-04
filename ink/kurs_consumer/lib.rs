#![cfg_attr(not(feature = "std"), no_std, no_main)]

//! KursRemit: an ink! v6 contract (PolkaVM, pallet-revive) that reads a Kurs
//! price feed from the Solidity KursOracle (EVM bytecode, same pallet) through
//! a Solidity-ABI cross-contract call, and refuses to quote on stale data.
//!
//! Kept deliberately small: pallet-revive charges a storage deposit per byte of
//! code (0.06 tPOT plus a 30% lockup on Portaldot V3). The oracle call is
//! therefore encoded by hand (4-byte selector + bytes32, a fixed 4-word reply)
//! instead of through ink!'s generic Solidity-ABI codec.

#[ink::contract]
mod kurs_remit {
    /// Kurs feeds use 8 decimals.
    const FEED_DECIMALS: u128 = 100_000_000;
    /// `latestRound(bytes32)` = keccak256 selector 0x34a50861; returns
    /// (uint80 roundId, int192 answer, uint64 observedAt, uint64 updatedAt), 4 x 32 bytes.
    const LATEST_ROUND: [u8; 4] = [0x34, 0xa5, 0x08, 0x61];

    #[ink(storage)]
    pub struct KursRemit {
        oracle: Address,
        feed_id: [u8; 32],
        /// Reject prices whose on-chain update is older than this many seconds.
        max_age: u64,
    }

    #[derive(Debug, PartialEq, Eq, Clone, Copy)]
    #[ink::error]
    pub enum Error {
        /// The feed has not been updated within `max_age`.
        StalePrice,
        /// The oracle returned zero or a negative price.
        BadPrice,
        Overflow,
    }

    /// Emitted by `quote_and_log`, so a cross-VM read leaves a transaction and an event.
    #[ink(event)]
    pub struct Quoted {
        amount: u128,
        converted: u128,
        round_id: u128,
    }

    /// The word at `i` of an ABI-encoded reply, low 16 bytes, big-endian.
    fn word(out: &[u8; 128], i: usize) -> [u8; 16] {
        let mut w = [0u8; 16];
        w.copy_from_slice(&out[i * 32 + 16..i * 32 + 32]);
        w
    }

    impl KursRemit {
        #[ink(constructor)]
        pub fn new(oracle: Address, feed_id: [u8; 32], max_age: u64) -> Self {
            Self { oracle, feed_id, max_age }
        }

        /// Latest round straight from the Solidity oracle: (roundId, answer, observedAt, updatedAt).
        #[ink(message)]
        pub fn latest(&self) -> (u128, i128, u64, u64) {
            let out = self.call_oracle();
            (
                u128::from_be_bytes(word(&out, 0)), // uint80
                i128::from_be_bytes(word(&out, 1)), // int192 within i128 range: the sign extends
                u128::from_be_bytes(word(&out, 2)) as u64,
                u128::from_be_bytes(word(&out, 3)) as u64,
            )
        }

        /// Converts `amount` (any base unit) at the latest fresh price, e.g. USD cents -> IDR cents.
        #[ink(message)]
        pub fn quote(&self, amount: u128) -> Result<u128, Error> {
            self.quote_inner(amount).map(|(c, _)| c)
        }

        /// Same as `quote`, as a transaction that emits `Quoted`.
        #[ink(message)]
        pub fn quote_and_log(&mut self, amount: u128) -> Result<u128, Error> {
            let (converted, round_id) = self.quote_inner(amount)?;
            self.env().emit_event(Quoted { amount, converted, round_id });
            Ok(converted)
        }

        fn quote_inner(&self, amount: u128) -> Result<(u128, u128), Error> {
            let (round_id, answer, _observed_at, updated_at) = self.latest();
            if answer <= 0 {
                return Err(Error::BadPrice);
            }
            // block timestamp is in milliseconds on Substrate; Kurs stores seconds
            let now = self.env().block_timestamp() / 1000;
            if now.saturating_sub(updated_at) > self.max_age {
                return Err(Error::StalePrice);
            }
            let converted = amount.checked_mul(answer as u128).ok_or(Error::Overflow)? / FEED_DECIMALS;
            Ok((converted, round_id))
        }

        /// Read-only call into the Solidity oracle; traps if the oracle reverts.
        #[cfg(not(feature = "std"))]
        fn call_oracle(&self) -> [u8; 128] {
            use pallet_revive_uapi::{CallFlags, HostFn, HostFnImpl};
            let mut input = [0u8; 36];
            input[..4].copy_from_slice(&LATEST_ROUND);
            input[4..].copy_from_slice(&self.feed_id);
            let mut out = [0u8; 128];
            HostFnImpl::call(
                CallFlags::READ_ONLY,
                &self.oracle.0,
                u64::MAX,       // all remaining ref_time, as ink!'s own calls do
                u64::MAX,       // all remaining proof_size
                &[u8::MAX; 32], // no deposit limit
                &[0u8; 32],     // no value
                &input,
                Some(&mut &mut out[..]),
            )
            .expect("oracle call reverted");
            out
        }

        /// Off-chain builds (metadata generation) never call the oracle.
        #[cfg(feature = "std")]
        fn call_oracle(&self) -> [u8; 128] {
            unimplemented!("on-chain only")
        }
    }
}
