#![cfg_attr(not(feature = "std"), no_std, no_main)]

//! KursRemit: an ink! v6 contract (PolkaVM, pallet-revive) that reads a Kurs
//! price feed from the Solidity KursOracle (EVM bytecode, same pallet) through
//! a Solidity-ABI cross-contract call, and refuses to quote on stale data.
//!
//! Kept deliberately small: pallet-revive charges a storage deposit per byte of
//! code (0.06 tPOT plus a 30% lockup on Portaldot V3), so every message here is
//! one the cross-VM demo needs.

/// The part of KursOracle this contract needs, described in Solidity ABI.
/// `latestRound(bytes32) returns (uint80 roundId, int192 answer, uint64 observedAt, uint64 updatedAt)`
#[ink::contract_ref(abi = "sol")]
pub trait KursOracle {
    #[ink(message, name = "latestRound")]
    fn latest_round(&self, feed_id: ink::sol::FixedBytes<32>) -> (u128, i128, u64, u64);
}

#[ink::contract]
mod kurs_remit {
    use super::{KursOracle, KursOracleRef};
    use ink::sol::FixedBytes;

    /// Kurs feeds use 8 decimals.
    const FEED_DECIMALS: u128 = 100_000_000;

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

    impl KursRemit {
        #[ink(constructor)]
        pub fn new(oracle: Address, feed_id: [u8; 32], max_age: u64) -> Self {
            Self { oracle, feed_id, max_age }
        }

        /// Latest round straight from the Solidity oracle: (roundId, answer, observedAt, updatedAt).
        #[ink(message)]
        pub fn latest(&self) -> (u128, i128, u64, u64) {
            let oracle: KursOracleRef = self.oracle.into();
            oracle.latest_round(FixedBytes(self.feed_id))
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
    }
}
