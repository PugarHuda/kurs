#![cfg_attr(not(feature = "std"), no_std, no_main)]

//! KursRemit: an ink! v6 contract (PolkaVM, pallet-revive) that reads a Kurs
//! price feed from the Solidity KursOracle (EVM bytecode, same pallet) through
//! a Solidity-ABI cross-contract call, and refuses to quote on stale data.
//!
//! Example use: quote how many Rupiah a USD amount is worth with USD/IDR.

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
        owner: Address,
    }

    #[derive(Debug, PartialEq, Eq, Clone, Copy)]
    #[ink::error]
    pub enum Error {
        /// The feed has not been updated within `max_age`.
        StalePrice,
        /// The oracle returned zero or a negative price.
        BadPrice,
        Overflow,
        NotOwner,
    }

    /// Emitted by `quote_and_log` so a quote is visible on chain.
    #[ink(event)]
    pub struct Quoted {
        amount: u128,
        converted: u128,
        round_id: u128,
        price: i128,
    }

    impl KursRemit {
        #[ink(constructor)]
        pub fn new(oracle: Address, feed_id: [u8; 32], max_age: u64) -> Self {
            Self { oracle, feed_id, max_age, owner: Self::env().caller() }
        }

        /// Latest round straight from the Solidity oracle: (roundId, answer, observedAt, updatedAt).
        #[ink(message)]
        pub fn latest(&self) -> (u128, i128, u64, u64) {
            let oracle: KursOracleRef = self.oracle.into();
            oracle.latest_round(FixedBytes(self.feed_id))
        }

        /// Converts `amount` (in the feed's base unit, any decimals) at the
        /// latest fresh price, e.g. USD cents -> IDR cents with USD/IDR.
        #[ink(message)]
        pub fn quote(&self, amount: u128) -> Result<u128, Error> {
            self.quote_inner(amount).map(|(c, _, _)| c)
        }

        /// Same as `quote` but emits `Quoted`, so the cross-VM read leaves a transaction.
        #[ink(message)]
        pub fn quote_and_log(&mut self, amount: u128) -> Result<u128, Error> {
            let (converted, round_id, price) = self.quote_inner(amount)?;
            self.env().emit_event(Quoted { amount, converted, round_id, price });
            Ok(converted)
        }

        #[ink(message)]
        pub fn set_max_age(&mut self, max_age: u64) -> Result<(), Error> {
            if self.env().caller() != self.owner {
                return Err(Error::NotOwner);
            }
            self.max_age = max_age;
            Ok(())
        }

        #[ink(message)]
        pub fn config(&self) -> (Address, [u8; 32], u64) {
            (self.oracle, self.feed_id, self.max_age)
        }

        fn quote_inner(&self, amount: u128) -> Result<(u128, u128, i128), Error> {
            let (round_id, answer, _observed_at, updated_at) = self.latest();
            if answer <= 0 {
                return Err(Error::BadPrice);
            }
            // block timestamp is in milliseconds on Substrate; Kurs stores seconds
            let now = self.env().block_timestamp() / 1000;
            if now.saturating_sub(updated_at) > self.max_age {
                return Err(Error::StalePrice);
            }
            let converted = amount
                .checked_mul(answer as u128)
                .ok_or(Error::Overflow)?
                / FEED_DECIMALS;
            Ok((converted, round_id, answer))
        }
    }
}
