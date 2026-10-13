import Link from 'next/link';
import { CHAIN_ID } from '@/lib/config';
import { LEGAL_CONTACT, RESTRICTED_JURISDICTIONS, TERMS_LAST_UPDATED } from '@/lib/legal';
import { LegalDocument, List, P, type LegalSection } from './LegalDocument';

/**
 * /terms. Written for a testnet run by contributors with no legal entity behind them: it
 * says what the product is, that nothing in it has value, what the user takes on, and how
 * far the contributors' liability is limited — to the extent the law allows, which is as
 * far as any such clause can honestly reach. Needs a lawyer's review before mainnet.
 */
const SECTIONS: LegalSection[] = [
  {
    id: 'agreement',
    title: 'Agreement',
    body: (
      <>
        <P>
          Whitespace is an open-source software project built and maintained by independent contributors
          (&ldquo;Whitespace&rdquo;, &ldquo;we&rdquo;, &ldquo;us&rdquo;). These Terms of Use govern your access to the
          Whitespace website and trading interface at whitespace.finance (the &ldquo;Interface&rdquo;).
        </P>
        <P>
          By accessing the Interface, connecting a wallet to it or using it to interact with any smart contract, you agree
          to these Terms and to our <Link href="/privacy">Privacy Policy</Link>. If you do not agree, do not use the
          Interface.
        </P>
      </>
    ),
  },
  {
    id: 'what-it-is',
    title: 'What Whitespace is',
    body: (
      <>
        <P>
          The Interface is a website that helps you prepare transactions for smart contracts deployed on the Whitechain
          testnet (chain {CHAIN_ID}). Whitespace is <strong>non-custodial</strong>: we never hold your private keys, your
          wallet or your tokens, and we cannot move them. Every transaction is signed by you, in your own wallet, and
          executed by smart contracts on a public blockchain.
        </P>
        <P>
          Prices are delivered by an oracle, and orders are completed, triggered and liquidated by automated off-chain
          services. These services are run by contributors on a best-effort basis and may be slow, wrong, paused or
          unavailable.
        </P>
      </>
    ),
  },
  {
    id: 'testnet',
    title: 'Testnet: nothing here has value',
    body: (
      <>
        <P>
          Whitespace currently runs only on a test network. <strong>USDW</strong> is a freely mintable test token and
          the <strong>WBT</strong> handed out by our faucet is test gas. Neither has any monetary value, and neither can
          be sold, redeemed or exchanged for anything of value through Whitespace.
        </P>
        <P>
          Balances, positions, profit and loss, vault shares and fees on the testnet are simulations. The test network,
          the contracts and the data shown in the Interface may be reset, redeployed or deleted at any time, without
          notice.
        </P>
      </>
    ),
  },
  {
    id: 'points',
    title: 'Points',
    body: (
      <>
        <P>
          Points measure activity on the testnet. They have <strong>no monetary value</strong>, are not property, and
          cannot be transferred, sold, exchanged or redeemed for anything.
        </P>
        <P>
          Points are <strong>not a promise, offer or expectation</strong> of any token, airdrop, allocation, reward or
          payment, now or in the future. We may change how points are earned, adjust or remove points (for example for
          duplicate wallets, automated activity or abuse of the faucet or the contracts), reset them, or end the
          programme at any time, at our sole discretion.
        </P>
      </>
    ),
  },
  {
    id: 'eligibility',
    title: 'Who may use Whitespace',
    body: (
      <>
        <P>You may use the Interface only if all of the following are true:</P>
        <List
          items={[
            'you are at least 18 years old, or the age of majority where you live if that is higher;',
            'you are not a citizen or resident of, and are not located in, a restricted jurisdiction listed below;',
            'you are not named on, or owned or controlled by anyone named on, a sanctions list maintained by the United Nations, the European Union, the United Kingdom or the United States;',
            'using Whitespace is lawful for you where you are.',
          ]}
        />
        <P>
          <strong>Restricted jurisdictions:</strong>
        </P>
        <List items={[...RESTRICTED_JURISDICTIONS]} />
        <P>
          You must not use a VPN or any other means to hide where you are in order to get around these restrictions. We
          may restrict or block access to the Interface from any place, or for any wallet, at any time.
        </P>
      </>
    ),
  },
  {
    id: 'risks',
    title: 'Risks you take on',
    body: (
      <>
        <P>Trading perpetual futures with leverage is high-risk. By using Whitespace you understand and accept that:</P>
        <List
          items={[
            'leverage multiplies losses as well as gains, and a position can be liquidated and its entire margin lost, quickly and without warning;',
            'fees are taken from your margin when a position opens, so the position can be smaller than the size you entered;',
            'orders execute at the oracle price when they are filled, which can differ from the price shown when you submitted them within the slippage you allow; limit orders fill at their price or better, and stop orders fill at the market once triggered, which can be worse than the stop price;',
            'oracle prices can be delayed, wrong or halted, and automated services can fail to fill, trigger or liquidate orders on time;',
            'the smart contracts have not been audited by an independent firm and may contain bugs that lose or lock funds;',
            'the contracts and their parameters are controlled by administrator keys and can be changed, paused, upgraded or replaced;',
            'blockchain networks, RPC providers and wallets can be congested, unavailable or compromised, and transactions can fail while still costing gas;',
            'blockchain transactions are final: we cannot reverse, cancel or refund them.',
          ]}
        />
      </>
    ),
  },
  {
    id: 'no-advice',
    title: 'No advice',
    body: (
      <P>
        Nothing in the Interface, in our documentation or in anything we publish is financial, investment, legal, tax or
        any other kind of advice, or a recommendation to trade. We owe you no fiduciary duty. You alone decide whether a
        transaction is right for you.
      </P>
    ),
  },
  {
    id: 'responsibilities',
    title: 'Your responsibilities',
    body: (
      <>
        <P>You are solely responsible for:</P>
        <List
          items={[
            'the security of your wallet, private keys, seed phrase and devices — including the one-click trading key, which is kept in your browser;',
            'checking every transaction before you sign it, including the network it is sent on;',
            'complying with the laws that apply to you, and for any taxes on your activity;',
            'any loss that results from your use of the Interface.',
          ]}
        />
        <P>
          You agree not to: abuse the faucets (for example by claiming from many wallets or networks you control),
          manipulate prices or points, use the Interface for anything unlawful, or attack, overload or interfere with
          the Interface, the contracts or the services behind them. If you find a vulnerability, report it to us instead
          of exploiting it.
        </P>
      </>
    ),
  },
  {
    id: 'third-parties',
    title: 'Third-party services',
    body: (
      <P>
        Whitespace relies on services we do not control: your wallet, the Whitechain network and its RPC nodes, block
        explorers, price sources, and sites you share to such as X and Telegram. Their availability, security and
        conduct are their own, and your use of them is governed by their own terms. Links to them are not endorsements.
      </P>
    ),
  },
  {
    id: 'warranties',
    title: 'No warranties',
    body: (
      <P>
        The Interface, the smart contracts, the oracle and every related service are provided <strong>&ldquo;as
        is&rdquo; and &ldquo;as available&rdquo;</strong>, with no warranty of any kind, express or implied — including
        any warranty of merchantability, fitness for a particular purpose, accuracy, availability, security or
        non-infringement — to the fullest extent permitted by law.
      </P>
    ),
  },
  {
    id: 'liability',
    title: 'Limitation of liability',
    body: (
      <>
        <P>
          To the fullest extent permitted by law, Whitespace and its contributors are not liable for any loss or damage
          arising from or connected with your use of, or inability to use, the Interface, the smart contracts or any
          related service — whether direct, indirect, incidental, consequential or special, and including loss of
          tokens, data, profits or opportunity — even if we were told such loss was possible.
        </P>
        <P>
          Some laws do not allow certain liability to be excluded or limited. Nothing in these Terms excludes or limits
          any liability that cannot lawfully be excluded or limited.
        </P>
      </>
    ),
  },
  {
    id: 'indemnity',
    title: 'Indemnity',
    body: (
      <P>
        You agree to indemnify and hold harmless Whitespace and its contributors from any claim, loss, liability or
        expense, including reasonable legal fees, that arises from your use of the Interface, your breach of these Terms
        or your violation of any law or the rights of anyone else.
      </P>
    ),
  },
  {
    id: 'changes',
    title: 'Changes and availability',
    body: (
      <P>
        We may change, suspend or discontinue the Interface or any feature of it, at any time and without notice. We may
        update these Terms; the date above shows the latest version. When a change is material we will ask you to agree
        again before you continue. If you keep using the Interface after a change, you accept the updated Terms.
      </P>
    ),
  },
  {
    id: 'contact',
    title: 'Contact',
    body: LEGAL_CONTACT ? (
      <P>
        Questions about these Terms: <a href={`mailto:${LEGAL_CONTACT}`}>{LEGAL_CONTACT}</a>.
      </P>
    ) : (
      <P>A contact address for questions about these Terms will be published on this page.</P>
    ),
  },
];

export function TermsOfUse() {
  return (
    <LegalDocument
      testId="terms"
      eyebrow="Legal"
      title="Terms of Use"
      updated={TERMS_LAST_UPDATED}
      lede="The short version: Whitespace is experimental testnet software. Nothing on it has value, leveraged trading can lose everything you put in, and you use it at your own risk and responsibility."
      sections={SECTIONS}
    />
  );
}
