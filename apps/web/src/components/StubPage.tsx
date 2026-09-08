/** Shared shell for nav entries with no backend yet (Points, Portfolio, Docs). Ruling:
 * build the layout so the nav is complete, but wire it to an explicit empty state — no
 * invented totals, ranks, or content. */
export function StubPage({ title, note }: { title: string; note: string }) {
  return (
    <div className="stub-page" data-testid="stub-page">
      <h1 className="mono-upper">{title}</h1>
      <p>
        <span className="badge badge-soon">Coming soon</span>
      </p>
      <p style={{ maxWidth: '32em', margin: '1rem auto' }}>{note}</p>
    </div>
  );
}
