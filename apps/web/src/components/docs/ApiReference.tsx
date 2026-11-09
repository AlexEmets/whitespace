'use client';

import Link from 'next/link';
import { useEffect, useState } from 'react';
import { useAccount } from 'wagmi';
import { API_GROUPS, WS_CHANNELS, WS_LIMITS, publicEndpoints, type ApiEndpoint } from '@whitespace/shared/api';
import { API_BASE_URL, SITE_URL } from '@/lib/config';
import { DocSection, LI, List, P } from './DocsArticle';
import api from './api.module.css';
import styles from './docs.module.css';

/**
 * /docs/api — the public API, for anyone building on top of the exchange.
 *
 * Every endpoint, parameter, limit and channel here comes from @whitespace/shared/api, which
 * services/api's test suite checks against the routes it really serves. Nothing in this file
 * restates an endpoint by hand, so the page cannot list a route that is gone or miss a new one.
 *
 * "Try it" calls the same API this site runs on (API_BASE_URL) and shows what came back,
 * unedited. The snippets quote the public address, which is what a reader will paste.
 */

/** The addresses a reader pastes into their own code. */
export const PUBLIC_API = `${SITE_URL}/api`;
export const PUBLIC_WS = `${SITE_URL.replace(/^http/, 'ws')}/ws`;

const ADDRESS_RE = /^0x[0-9a-fA-F]{40}$/;
/** Lines of a response shown before the rest is folded away. */
export const RESPONSE_PREVIEW_LINES = 40;

const ENDPOINTS = publicEndpoints();
const needsWallet = (e: ApiEndpoint) => e.path.includes(':address');

/** Groups with at least one public endpoint, each a section of its own. */
const GROUPS = API_GROUPS.filter((g) => ENDPOINTS.some((e) => e.group === g.id));

const SECTIONS = [
  { id: 'start', title: 'Quick start' },
  { id: 'conventions', title: 'Conventions' },
  ...GROUPS,
  { id: 'websocket', title: 'WebSocket' },
  { id: 'fair-use', title: 'Fair use' },
];

function Code({ children, label }: { children: string; label: string }) {
  const [copied, setCopied] = useState(false);
  const copy = () => {
    void navigator.clipboard
      ?.writeText(children)
      .then(() => {
        setCopied(true);
        setTimeout(() => setCopied(false), 1500);
      })
      .catch(() => undefined);
  };
  return (
    <div className={api.codeWrap}>
      <div className={`${api.codeHead} mono-upper`}>
        <span>{label}</span>
        <button type="button" className={api.copy} onClick={copy}>
          {copied ? 'Copied' : 'Copy'}
        </button>
      </div>
      <pre className={api.code}>
        <code>{children}</code>
      </pre>
    </div>
  );
}

type TryState =
  | { kind: 'idle' }
  | { kind: 'loading' }
  | { kind: 'done'; status: number; ms: number; text: string; items: number | null }
  | { kind: 'failed'; message: string };

/** A response as pretty JSON, cut to the first RESPONSE_PREVIEW_LINES lines. */
export function previewJson(body: unknown): { text: string; items: number | null } {
  const lines = JSON.stringify(body, null, 2).split('\n');
  const shown = lines.slice(0, RESPONSE_PREVIEW_LINES);
  if (lines.length > shown.length) shown.push(`… ${lines.length - shown.length} more lines`);
  return { text: shown.join('\n'), items: Array.isArray(body) ? body.length : null };
}

function TryIt({ endpoint, wallet }: { endpoint: ApiEndpoint; wallet: string }) {
  const [state, setState] = useState<TryState>({ kind: 'idle' });
  const walletOk = ADDRESS_RE.test(wallet);
  const blocked = needsWallet(endpoint) && !walletOk;
  const path = endpoint.example!.replace(':address', wallet.toLowerCase());

  const run = async () => {
    setState({ kind: 'loading' });
    const started = performance.now();
    try {
      const res = await fetch(`${API_BASE_URL}${path}`);
      const body: unknown = await res.json();
      setState({ kind: 'done', status: res.status, ms: Math.round(performance.now() - started), ...previewJson(body) });
    } catch (err) {
      setState({ kind: 'failed', message: err instanceof Error ? err.message : String(err) });
    }
  };

  return (
    <div className={api.try}>
      <div className={api.tryBar}>
        <code className={api.tryPath}>GET {blocked ? endpoint.example : path}</code>
        <button
          type="button"
          className={api.tryButton}
          onClick={() => void run()}
          disabled={blocked || state.kind === 'loading'}
          data-testid={`try-${endpoint.path}`}
        >
          {state.kind === 'loading' ? 'Calling…' : 'Try it'}
        </button>
      </div>
      {blocked && <p className={api.tryHint}>Enter a wallet above to try this one.</p>}
      {state.kind === 'done' && (
        <div data-testid={`response-${endpoint.path}`}>
          <div className={`${api.tryMeta} mono-upper`}>
            <span className={state.status < 400 ? api.ok : api.bad}>{state.status}</span>
            <span>{state.ms} ms</span>
            {state.items !== null && <span>{state.items === 1 ? '1 item' : `${state.items} items`}</span>}
          </div>
          <pre className={api.response}>
            <code>{state.text}</code>
          </pre>
        </div>
      )}
      {state.kind === 'failed' && (
        <p className={api.tryError} role="alert" data-testid={`response-${endpoint.path}`}>
          Could not reach the API: {state.message}
        </p>
      )}
    </div>
  );
}

function Endpoint({ endpoint, wallet }: { endpoint: ApiEndpoint; wallet: string }) {
  return (
    <article className={api.endpoint} data-testid={`endpoint-${endpoint.path}`}>
      <h3 className={api.endpointHead}>
        <span className={`${api.method} mono-upper`}>{endpoint.method}</span>
        <code className={api.path}>{endpoint.path}</code>
      </h3>
      <p className={api.summary}>{endpoint.summary}</p>
      {(endpoint.params.length > 0 || endpoint.limit) && (
        <dl className={api.params}>
          {endpoint.params.map((p) => (
            <div key={p.name} className={api.param}>
              <dt>
                <code>{p.name}</code> <span className={api.paramIn}>{p.in}</span>
              </dt>
              <dd>{p.description}</dd>
            </div>
          ))}
          {endpoint.limit && (
            <div className={api.param}>
              <dt>
                <code>limit</code> <span className={api.paramIn}>query</span>
              </dt>
              <dd>
                How many to return, 1 to {endpoint.limit.max.toLocaleString('en-US')}. Default{' '}
                {endpoint.limit.default.toLocaleString('en-US')}.
              </dd>
            </div>
          )}
        </dl>
      )}
      <TryIt endpoint={endpoint} wallet={wallet} />
    </article>
  );
}

const QUICK_CURL = `curl ${PUBLIC_API}/price/0`;

const QUICK_JS = `const API = '${PUBLIC_API}';

// Every market and its live mark price
const markets = await fetch(\`\${API}/markets\`).then((r) => r.json());
for (const m of markets) {
  const price = await fetch(\`\${API}/price/\${m.pairIndex}\`).then((r) => r.json());
  console.log(\`\${m.from}-PERP\`, price.mark);
}

// Then follow BTC live instead of polling
const ws = new WebSocket('${PUBLIC_WS}');
ws.onopen = () => ws.send(JSON.stringify({ type: 'subscribe', channel: 'price:0' }));
ws.onmessage = (e) => {
  const msg = JSON.parse(e.data);
  if (msg.type === 'update') console.log('BTC-PERP', msg.data.mark);
};`;

const QUICK_PY = `import requests

API = "${PUBLIC_API}"

for m in requests.get(f"{API}/markets").json():
    price = requests.get(f"{API}/price/{m['pairIndex']}").json()
    print(f"{m['from']}-PERP", price["mark"])`;

const WS_PROTOCOL = `→ {"type":"subscribe","channel":"price:0"}
← {"type":"subscribed","channel":"price:0"}
← {"type":"update","channel":"price:0","data":{"index":"…","mark":"…", …}}
→ {"type":"unsubscribe","channel":"price:0"}
← {"type":"unsubscribed","channel":"price:0"}
← {"type":"error","channel":"…","error":"invalid channel or too many subscriptions"}`;

export function ApiReference() {
  const { address } = useAccount();
  const [wallet, setWallet] = useState('');
  // The connected wallet fills the field once, and only while it is still empty: a reader who
  // typed someone else's address is not overruled by connecting their own.
  useEffect(() => {
    if (address) setWallet((w) => (w === '' ? address : w));
  }, [address]);
  const walletBad = wallet !== '' && !ADDRESS_RE.test(wallet);

  const afterGroups = 3 + GROUPS.length;
  return (
    <div data-testid="api-page">
      <header className={styles.head}>
        <div className={`${styles.eyebrow} mono-upper`}>Developers</div>
        <h1 className={styles.title}>Whitespace API</h1>
        <p className={styles.lede}>
          Everything this site shows comes from one public API: markets, live prices, candles, positions, trade
          history, fees, points and the LP vault. It is read-only and needs no key, and it is the same API the terminal
          runs on. Build a bot, a dashboard, alerts or a leaderboard of your own.
        </p>
        <div className={api.bases}>
          <div>
            <span className="mono-upper">REST</span>
            <code data-testid="api-base">{PUBLIC_API}</code>
          </div>
          <div>
            <span className="mono-upper">WebSocket</span>
            <code data-testid="ws-base">{PUBLIC_WS}</code>
          </div>
        </div>
      </header>

      <div className={styles.layout}>
        <nav className={styles.toc} aria-label="Contents">
          <div className={`${styles.tocLabel} mono-upper`}>Contents</div>
          <ol className={styles.tocList}>
            {SECTIONS.map((s) => (
              <li key={s.id}>
                <a href={`#${s.id}`}>{s.title}</a>
              </li>
            ))}
          </ol>
        </nav>

        <div className={styles.body}>
          <DocSection index={1} id="start" title="Quick start">
            <P>One request, no sign-up:</P>
            <Code label="Shell">{QUICK_CURL}</Code>
            <P>Every market with its live price, then a live feed for one of them:</P>
            <Code label="JavaScript · Node 22 as an .mjs file, or this site's browser console">{QUICK_JS}</Code>
            <Code label="Python">{QUICK_PY}</Code>
          </DocSection>

          <DocSection index={2} id="conventions" title="Conventions">
            <List>
              <LI>
                <strong>Numbers are decimal strings</strong>, never floats, so nothing is rounded on the way:{' '}
                <code>&quot;74198.138982478631852091&quot;</code>. Prices carry 18 decimals, USDW amounts 6, leverage 2.
                Parse them with a decimal library if you do maths on them.
              </LI>
              <LI>
                <strong>Times are unix seconds.</strong> Addresses are accepted in any case and returned lower-case.
              </LI>
              <LI>
                <strong>Markets are numbered.</strong> <code>pairIndex</code> 0 is BTC; <code>GET /markets</code> lists
                the rest.
              </LI>
              <LI>
                <strong>Errors are JSON</strong> with a status to match: <code>{'{"error":"invalid address"}'}</code> is a
                400, an unknown market a 404.
              </LI>
              <LI>
                <strong>It is a testnet.</strong> USDW is a faucet token, and a redeploy of the contracts starts the
                history over.
              </LI>
            </List>
            <div className={api.walletRow}>
              <label htmlFor="api-wallet" className="mono-upper">
                Wallet for the examples
              </label>
              <input
                id="api-wallet"
                className={`${api.wallet} ${walletBad ? api.walletBad : ''}`}
                value={wallet}
                onChange={(e) => setWallet(e.target.value.trim())}
                placeholder="0x…"
                spellCheck={false}
                autoComplete="off"
                data-testid="api-wallet"
              />
              {walletBad && <span className={api.walletHint}>That is not a wallet address.</span>}
            </div>
          </DocSection>

          {GROUPS.map((group, i) => (
            <DocSection key={group.id} index={3 + i} id={group.id} title={group.title}>
              <div className={api.endpoints}>
                {ENDPOINTS.filter((e) => e.group === group.id).map((e) => (
                  <Endpoint key={e.path} endpoint={e} wallet={wallet} />
                ))}
              </div>
            </DocSection>
          ))}

          <DocSection index={afterGroups} id="websocket" title="WebSocket">
            <P>
              Connect to <code>{PUBLIC_WS}</code>, subscribe to channels by name, and the server pushes a channel again
              whenever its value changes. Values are checked every {WS_LIMITS.pollIntervalMs / 1000} seconds. An update
              comes only on a change, so read the REST endpoint once for the current value, then follow the channel.
            </P>
            <Code label="Messages">{WS_PROTOCOL}</Code>
            <table className={styles.table}>
              <thead>
                <tr>
                  <th>Channel</th>
                  <th>What it pushes</th>
                </tr>
              </thead>
              <tbody>
                {WS_CHANNELS.map((c) => (
                  <tr key={c.kind} data-testid={`channel-${c.kind}`}>
                    <td className={styles.td}>
                      <code>{c.pattern}</code>
                    </td>
                    <td className={`${styles.td} ${api.channelSummary}`}>{c.summary}</td>
                  </tr>
                ))}
              </tbody>
            </table>
          </DocSection>

          <DocSection index={afterGroups + 1} id="fair-use" title="Fair use">
            <List>
              <LI>
                <strong>No key, no sign-up.</strong> Please keep polling to about once a second per endpoint, and use the
                WebSocket for anything live.
              </LI>
              <LI>
                <strong>One client</strong> can hold {WS_LIMITS.connectionsPerIp} sockets at once, each with up to{' '}
                {WS_LIMITS.subscriptionsPerSocket} channels.
              </LI>
              <LI>
                <strong>Scripts, bots and servers can call it directly.</strong> A web page on another domain cannot
                call it from the browser yet; proxy it through your own backend for now.
              </LI>
              <LI>
                <strong>Built something, or found a wrong number?</strong> Tell us: the chats and the bug form are under{' '}
                <Link href="/docs#community">Community &amp; support</Link>.
              </LI>
            </List>
          </DocSection>
        </div>
      </div>
    </div>
  );
}
