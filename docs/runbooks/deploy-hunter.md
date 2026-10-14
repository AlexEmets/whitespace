# Runbook: Hunter bug-bounty NFT collection (chain 1874)

The `Hunter` collection (`contracts/src/nft/Hunter.sol`) is a standalone, owner-minted ERC-721,
hard-capped at **100**, with fully on-chain SVG art (no IPFS, no metadata server). The owner
holds the badges and hands one to each researcher who reports a valid bug. The `/points` page
shows a connected wallet's badges, read straight from chain (`ERC721Enumerable`), so no indexer
or API change is needed.

## Live deployment (Whitechain Sepolia, chain 1874)

| | |
|---|---|
| **Hunter contract** | `0x50B15b34eEf866E01fDF429008365a5aB57B0353` |
| **owner / minter** | `0xDa13C59838D9edDBD313b9B32FC47F5F2D65D113` (`~/.whitespace-keys/owner.json`) |
| first recipient | `0xAb03f4176Ce1BC22Aa434fF23B8f38B1284630E8` (holds `Hunter #0`) |
| explorer | https://explorer.testnet.whitechain.io/address/0x50B15b34eEf866E01fDF429008365a5aB57B0353 |

The address also lives in `deployments/hunter-1874.json`, which the frontend reads
(`apps/web/src/lib/hunter.ts`). A zero address there hides the badges section.

## Common shell setup

```bash
export PATH="$PATH:$HOME/.foundry/bin"
RPC=https://rpc.testnet.whitechain.io
HUNTER=0x50B15b34eEf866E01fDF429008365a5aB57B0353
# owner key is read from the file, so it never appears in the command text:
OWNER_PK() { jq -r '.[0].private_key' ~/.whitespace-keys/owner.json; }
```

If `~/.whitespace-keys/owner.json` is missing, create it yourself (so the key never passes
through a tool), mode 600:

```bash
mkdir -p ~/.whitespace-keys && chmod 700 ~/.whitespace-keys
cat > ~/.whitespace-keys/owner.json <<'EOF'
[{"address":"0xDa13C59838D9edDBD313b9B32FC47F5F2D65D113","private_key":"0x<OWNER_KEY>"}]
EOF
chmod 600 ~/.whitespace-keys/owner.json
```

## Mint — reward a hunter (owner only, up to 100 total)

```bash
# one badge to one wallet
cast send "$HUNTER" "mint(address)" 0x<WALLET> \
  --rpc-url $RPC --private-key "$(OWNER_PK)" --legacy

# several wallets in one tx
cast send "$HUNTER" "airdrop(address[])" "[0x<W1>,0x<W2>,0x<W3>]" \
  --rpc-url $RPC --private-key "$(OWNER_PK)" --legacy

# N badges into one wallet (e.g. seed the owner's own stock)
cast send "$HUNTER" "mintBatch(address,uint256)" 0x<WALLET> 5 \
  --rpc-url $RPC --private-key "$(OWNER_PK)" --legacy
```

## Read — state & holdings

```bash
cast call "$HUNTER" "totalSupply()(uint256)" --rpc-url $RPC   # minted so far
cast call "$HUNTER" "remaining()(uint256)"   --rpc-url $RPC   # still mintable (of 100)
cast call "$HUNTER" "balanceOf(address)(uint256)" 0x<WALLET> --rpc-url $RPC
cast call "$HUNTER" "tokenOfOwnerByIndex(address,uint256)(uint256)" 0x<WALLET> 0 --rpc-url $RPC
cast call "$HUNTER" "ownerOf(uint256)(address)" 0 --rpc-url $RPC
```

## Preview a badge (decode on-chain SVG → PNG)

```bash
ID=0
cast call "$HUNTER" "tokenURI(uint256)(string)" $ID --rpc-url $RPC \
  | sed 's/^"//; s/"$//; s#^data:application/json;base64,##' | base64 -d \
  | jq -r .image | sed 's#^data:image/svg+xml;base64,##' | base64 -d > /tmp/hunter-$ID.svg
magick -background none /tmp/hunter-$ID.svg /tmp/hunter-$ID.png   # or open the .svg in a browser
```

## Deploy from scratch (if redeploying)

`--legacy` is mandatory on Whitechain. `HUNTER_MINT_TO` is the initial recipient;
`HUNTER_INITIAL_MINT` defaults to 5.

```bash
cd contracts
export DEPLOYER_PRIVATE_KEY="$(OWNER_PK)"
export HUNTER_MINT_TO=0xAb03f4176Ce1BC22Aa434fF23B8f38B1284630E8
export HUNTER_INITIAL_MINT=1
forge script script/DeployHunter.s.sol:DeployHunterScript \
  --rpc-url $RPC --broadcast --legacy --slow --sender "$(addr owner)" -vvv
# then write the printed address into deployments/hunter-1874.json:
jq --arg a 0x<NEW_HUNTER> '.address=$a' deployments/hunter-1874.json > /tmp/h.json \
  && mv /tmp/h.json deployments/hunter-1874.json
```

## Build / test / run the frontend

```bash
cd contracts && forge test --match-path 'test/Hunter.t.sol' -vv   # 24 tests
forge lint src/nft/Hunter.sol                                     # must be clean

cd "$(git rev-parse --show-toplevel)"
pnpm --filter @whitespace/web test     # includes tests/unit/hunter.test.ts
pnpm --filter @whitespace/web dev        # http://localhost:3000 — open /points, connect the wallet
# production: pnpm --filter @whitespace/web build
```

The **Hunter badges** card on `/points` renders each badge from its own on-chain SVG. It shows
for any connected wallet that holds a badge, and stays visible even if the points API is down
(the badges are chain reads, not API reads).
