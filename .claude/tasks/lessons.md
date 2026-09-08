# Lessons

## 2026-09-08 — Presented an architecture without defending it against the obvious alternative

**What happened.** In design section 1 I presented the LP-vault-as-counterparty model as settled,
explaining *how* it works but never *why it beats an order book*. The user pushed back: "vault
instead of an order book — isn't that a crutch? Hyperliquid has an order book, or is it only on
the frontend?"

**The missed tell.** The user had already said "ideally inherit existing code" and named
Hyperliquid unprompted — they were benchmarking against the market leader. When the chosen
architecture differs from the most visible product in the category, the comparison is not
optional background, it is the first question a reader will have.

**Why it mattered.** The answer was strong and evidence-backed once I looked: Hyperliquid's book
is genuinely fully on-chain, and it required a bespoke BFT consensus, a matching engine inside
chain state, 0.2 s median end-to-end latency and an order-book-aware mempool. None of that is
reachable on a 1 s-block EVM chain. Presenting that upfront would have converted a challenge
into confidence.

**Rule.** When recommending an architecture that visibly differs from the category leader, name
the leader and give the decisive reason in the same breath as the recommendation — before being
asked. One row of "why not X" beats a paragraph of "how our thing works".

## 2026-09-08 — Fanned out too many research subagents and lost the whole batch

**What happened.** Launched 4 research subagents in parallel; each fanned out further into
dozens of its own children. The session's WebSearch budget (200, shared session-wide) was
exhausted and every agent died on an API session limit. Zero reports returned.

**What worked instead.** Direct `curl` JSON-RPC probes against the chain, GitHub API for
licenses, and `git clone --depth 1` for source reading. These produced better evidence than the
agents would have — measurements and verbatim license text rather than summaries — at a
fraction of the cost.

**Rule.** For questions answerable by probing a primary source (chain state, a LICENSE file,
a repo tree), probe it directly. Reserve subagents for genuinely open-ended search, and launch
few enough that one failure does not take the batch with it.

## 2026-09-08 — A truncated grep produced a false alarm about stuck user funds

**What happened.** Grepped `OstiumTrading.sol` for timeout handling with `head -40`, saw only
setters, and reported to the user that `marketOrdersTimeout` appeared unused — implying trader
collateral could be stranded when the keeper is down. The recovery functions existed at lines
652 and 686, past the truncation.

**Rule.** When a grep is being used to establish a *negative* ("this mechanism does not exist"),
never truncate the output. Count matches first, or clone the repo and grep it whole. A truncated
search proves nothing about absence.
