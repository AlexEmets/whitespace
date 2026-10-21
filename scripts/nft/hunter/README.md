# Hunter NFT scripts

Operational scripts for the **Hunter** bug-bounty collection
(`contracts/src/nft/Hunter.sol`) — an owner-minted, 100-cap ERC-721 with fully on-chain art.
Full background: `docs/runbooks/deploy-hunter.md`.

| file | what it does |
|---|---|
| `common.sh` | shared setup (chain → RPC + `deployments/hunter-<CHAIN>.json`, owner-key + address helpers). Sourced by the others. |
| `deploy.sh` | deploy the collection to a chain and record its address. |
| `mint.sh` | mint badges to one or more wallets (owner only). |
| `holders.sh` | list current holders, read straight from chain. |

## Chains

Pick the chain with the `CHAIN` env var — **default `1874`** (Whitechain testnet), or `1875`
(mainnet). Each chain has its own `deployments/hunter-<CHAIN>.json`; testnet's is also what the
frontend reads. Nothing else changes between chains.

| | testnet | mainnet |
|---|---|---|
| `CHAIN` | `1874` (default) | `1875` |
| RPC | `rpc.testnet.whitechain.io` | `rpc.whitechain.io` |
| explorer | `explorer.testnet.whitechain.io` | `explorer.whitechain.io` |

Minting/deploying needs the owner key at `~/.whitespace-keys/owner.json` (override with
`HUNTER_OWNER_KEY_FILE`); read scripts (`holders.sh`) need no key. The owner wallet
(`0xDa13…D113`) **must be funded with WBT on the target chain** — the same address exists on
every chain but each has its own balance.

## Mainnet: deploy + hand out to wallets

```bash
# 0. fund the owner wallet with WBT on mainnet first (~0.05 WBT covers deploy + an airdrop).
# 1. dry-run the deploy (simulates, broadcasts nothing):
CHAIN=1875 scripts/nft/hunter/deploy.sh --dry-run
# 2. deploy for real (clean collection, no initial mint) — writes the address into hunter-1875.json:
CHAIN=1875 scripts/nft/hunter/deploy.sh
# 3. hand one badge to each wallet in a single airdrop tx (preview first with --dry-run):
CHAIN=1875 scripts/nft/hunter/mint.sh --dry-run 0xW1 0xW2 0xW3
CHAIN=1875 scripts/nft/hunter/mint.sh          0xW1 0xW2 0xW3
# 4. confirm:
CHAIN=1875 scripts/nft/hunter/holders.sh --by-owner
```

## Award a badge (any chain)

```bash
scripts/nft/hunter/mint.sh 0xWALLET                 # one badge to one wallet   (mint)
scripts/nft/hunter/mint.sh 0xW1 0xW2 0xW3           # one badge to each wallet  (airdrop, one tx)
scripts/nft/hunter/mint.sh --count 5 0xWALLET       # 5 badges into one wallet  (mintBatch)
scripts/nft/hunter/mint.sh --dry-run 0xW1 0xW2      # preflight only, send nothing
```

Token ids are assigned sequentially in mint order, so the script prints exactly which id each
wallet gets (and refuses up front if the request would exceed the 100 cap).

## See who holds what

```bash
scripts/nft/hunter/holders.sh             # id -> owner table
scripts/nft/hunter/holders.sh --by-owner  # grouped by wallet, with counts
```
