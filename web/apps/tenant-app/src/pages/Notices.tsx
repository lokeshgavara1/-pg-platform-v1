import { Async, Card, EmptyState, formatDateTime, PageHead, useApi, useAsync } from 'pg-core';

export function NoticesPage() {
  const client = useApi();
  const state = useAsync(() => client.get<{ items: { id: string; title: string; body: string; createdAt: string; room: { name: string } | null }[] }>('/api/tenant/notices'), []);
  return (
    <>
      <PageHead title="Notices" sub="Announcements from your PG." />
      <Async state={state} empty={(d) => (d.items.length === 0 ? <Card><EmptyState title="No notices" glyph="✉" /></Card> : null)}>
        {(d) => (
          <div className="stack reveal">
            {d.items.map((n) => (
              <Card key={n.id} ledger>
                <h3>{n.title}</h3>
                <p style={{ whiteSpace: 'pre-wrap' }}>{n.body}</p>
                <div className="faint">{n.room ? `Room ${n.room.name} · ` : ''}{formatDateTime(n.createdAt)}</div>
              </Card>
            ))}
          </div>
        )}
      </Async>
    </>
  );
}
