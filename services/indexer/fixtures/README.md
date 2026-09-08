# Fixtures

Raw `eth_getTransactionReceipt` logs captured directly from Whitechain testnet
1874 (`https://rpc.testnet.whitechain.io`) for the two proof-trade
transactions recorded in `deployments/1874-operational.json`:

- `open-request-tx.json` — receipt for `proofTrade.openTradeTx`
  (`0xa9d854259b741621aa92ef8cd763abd1ff4f75b3e9d23aa3dfe8ef34d7456277`),
  block `0x6f27e7`. Contains `MarketOpenOrderInitiated` (Trading) and
  `PriceRequestedV2` (PriceUpKeep) — phase 1 of the two-phase order flow.
- `open-report-tx.json` — receipt for `proofTrade.openReportTx`
  (`0x14b55e4006195f32cd51eeb65c96a7b26e446d3101ba873e10fb1541e5e61011`),
  block `0x6f27ec`. Contains the `MarketOpenExecuted` log emitted by
  `TradingCallbacks` (`0x4084cd63dB84c88c98418e33b88449b3b006da9c`).
- `close-report-tx.json` — receipt for `proofTrade.closeReportTx`
  (`0xaa0d4683a5b2213e8b6886073712d1bde606dac54868b77382be7b97203d37b5`),
  block containing the `MarketCloseExecutedV2` log, also emitted by
  `TradingCallbacks`.

Captured 2026-09-08 via direct JSON-RPC `eth_getTransactionReceipt` calls
(see `docs/decisions/phase-4-indexer-api.md` for the exact commands). These
are frozen snapshots so `test/decode.test.ts` can assert against real chain
data without a network call on every test run.
