import type { ReactNode } from 'react';
import styles from '../docs/docs.module.css';

export interface LegalSection {
  id: string;
  title: string;
  body: ReactNode;
}

/**
 * The shell both legal pages share, in the /docs layout: a head, a numbered table of
 * contents, and one panel per section — so a long document reads like the rest of the site
 * and every clause can be linked to by its anchor.
 */
export function LegalDocument({
  testId,
  eyebrow,
  title,
  updated,
  lede,
  sections,
}: {
  testId: string;
  eyebrow: string;
  title: string;
  updated: string;
  lede: ReactNode;
  sections: LegalSection[];
}) {
  return (
    <div data-testid={testId}>
      <header className={styles.head}>
        <div className={`${styles.eyebrow} mono-upper`}>{eyebrow}</div>
        <h1 className={styles.title}>{title}</h1>
        <p className={styles.lede}>{lede}</p>
        <p className={styles.lede} data-testid={`${testId}-updated`}>
          Last updated {updated}.
        </p>
      </header>

      <div className={styles.layout}>
        <nav className={styles.toc} aria-label="Contents">
          <div className={`${styles.tocLabel} mono-upper`}>Contents</div>
          <ol className={styles.tocList}>
            {sections.map((section) => (
              <li key={section.id}>
                <a href={`#${section.id}`}>{section.title}</a>
              </li>
            ))}
          </ol>
        </nav>

        <div className={styles.body}>
          {sections.map((section, i) => (
            <section key={section.id} className={styles.section} id={section.id} data-testid={`${testId}-${section.id}`}>
              <div className={`${styles.sectionNumber} mono-upper`}>{String(i + 1).padStart(2, '0')}</div>
              <h2 className={styles.h2}>{section.title}</h2>
              {section.body}
            </section>
          ))}
        </div>
      </div>
    </div>
  );
}

export function P({ children }: { children: ReactNode }) {
  return <p className={styles.p}>{children}</p>;
}

export function List({ items }: { items: ReactNode[] }) {
  return (
    <ul className={styles.list}>
      {items.map((item, i) => (
        <li key={i} className={styles.li}>
          {item}
        </li>
      ))}
    </ul>
  );
}
