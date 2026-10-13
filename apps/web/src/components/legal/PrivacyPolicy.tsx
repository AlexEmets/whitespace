import Link from 'next/link';
import { LEGAL_CONTACT, TERMS_LAST_UPDATED } from '@/lib/legal';
import { LegalDocument, List, P, type LegalSection } from './LegalDocument';

/**
 * /privacy. Every statement here describes what the code actually does, checked against
 * it rather than copied from a template:
 *
 *  - the WBT faucet keeps address + IP (IPv4, or the IPv6 /64) + time + tx hash in its own
 *    Postgres schema, with no expiry (services/api/src/faucet.ts);
 *  - the API counts open WebSockets per IP in memory only (services/api/src/ws.ts);
 *  - Caddy has no `log` directive, so no access log is written (deploy/Caddyfile), and the
 *    journal keeps service logs for 14 days (deploy/journald/whitespace.conf);
 *  - the site sets no cookies, loads no analytics, and self-hosts its fonts (next/font);
 *  - localStorage holds the theme, chart mode, open vault requests, first-connect and Terms
 *    markers, and the one-click trading key (lib/sessionKey.ts).
 *
 * Change this page whenever any of those does.
 */
const SECTIONS: LegalSection[] = [
  {
    id: 'who',
    title: 'Who we are',
    body: (
      <P>
        Whitespace is an open-source project built by independent contributors (&ldquo;we&rdquo;, &ldquo;us&rdquo;).
        This policy explains what information the Whitespace website and its servers handle, and why. It applies
        together with our <Link href="/terms">Terms of Use</Link>.
      </P>
    ),
  },
  {
    id: 'not-collected',
    title: 'What we do not collect',
    body: (
      <List
        items={[
          'There are no accounts: we never ask for your name, email address, phone number or any identity document.',
          'We do not set cookies.',
          'We use no analytics, advertising or tracking tools, and we do not sell or share data with advertisers.',
          'Fonts are served from our own server, so loading the site makes no requests to Google or similar providers.',
        ]}
      />
    ),
  },
  {
    id: 'faucet',
    title: 'The WBT faucet',
    body: (
      <>
        <P>When you request test WBT, our server records:</P>
        <List
          items={[
            'the wallet address the WBT is sent to;',
            'your IP address — for IPv6, only the /64 network prefix;',
            'the time of the request, its outcome and the transaction hash.',
          ]}
        />
        <P>
          We use this only to enforce the faucet&rsquo;s limit of one claim per wallet and per network every 24 hours,
          and to stop abuse, which keeps test gas available for everyone. That is our legitimate interest in processing
          it. These records are kept for as long as the faucet runs.
        </P>
      </>
    ),
  },
  {
    id: 'servers',
    title: 'Our servers',
    body: (
      <>
        <P>
          The website, its API and its blockchain RPC proxy run on our server, which necessarily sees the IP address of
          each request. Our web server does not write access logs. The API counts open live-data connections per IP
          address in memory, to limit them; this count is not stored.
        </P>
        <P>
          Operational logs of our services, which can contain technical details of requests, are kept for at most 14
          days.
        </P>
      </>
    ),
  },
  {
    id: 'blockchain',
    title: 'Public blockchain data',
    body: (
      <P>
        Wallet addresses, transactions, positions and orders on Whitechain are public by the nature of a blockchain.
        Our indexer reads them to show your positions, history, points and share cards. Anyone can see this data on the
        chain, and neither we nor anyone else can delete it.
      </P>
    ),
  },
  {
    id: 'browser',
    title: 'Stored in your browser',
    body: (
      <>
        <P>The site keeps some settings in your browser&rsquo;s local storage. They never leave your device:</P>
        <List
          items={[
            'your theme and chart preferences;',
            'vault deposit and withdrawal requests you have open, so they survive a reload;',
            'whether you have seen the setup guide, and that you agreed to the Terms;',
            'the one-click trading key, if you turn one-click trading on. It is a private key held only in this browser and never sent to us. It can open and close positions on your behalf but cannot withdraw your funds; anyone with access to this browser profile could use it to trade, so turn one-click trading off on a shared device.',
          ]}
        />
        <P>You can remove all of it by clearing this site&rsquo;s data in your browser.</P>
      </>
    ),
  },
  {
    id: 'third-parties',
    title: 'Third parties',
    body: (
      <P>
        Your wallet, the Whitechain RPC nodes it talks to, block explorers, and sites you share to such as X and
        Telegram receive information under their own privacy policies, not ours. For example, a public RPC node can see
        the IP address your wallet connects from.
      </P>
    ),
  },
  {
    id: 'rights',
    title: 'Your rights',
    body: (
      <P>
        Depending on where you live, you may have the right to access, correct or delete personal data we hold about
        you, or to object to how we use it. The only such data we keep is the faucet record described above.{' '}
        {LEGAL_CONTACT ? (
          <>
            To exercise these rights, write to <a href={`mailto:${LEGAL_CONTACT}`}>{LEGAL_CONTACT}</a>.
          </>
        ) : (
          <>A contact address for these requests will be published on this page.</>
        )}
      </P>
    ),
  },
  {
    id: 'changes',
    title: 'Changes',
    body: (
      <P>
        We will update this policy when what we handle changes. The date above shows the latest version.
      </P>
    ),
  },
];

export function PrivacyPolicy() {
  return (
    <LegalDocument
      testId="privacy"
      eyebrow="Legal"
      title="Privacy Policy"
      updated={TERMS_LAST_UPDATED}
      lede="Whitespace has no accounts, no cookies and no analytics. The one piece of personal data our servers keep is the faucet record that stops test gas being drained."
      sections={SECTIONS}
    />
  );
}
