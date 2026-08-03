import { Clock3 } from "lucide-react";
import type { AgentRunRecord } from "@contracts";

export function HistoryPanel({ history }: { history: AgentRunRecord[] }) {
  return (
    <section className="bottom-card history-card">
      <header>
        <div>
          <h2>Task History</h2>
          <p>Stored in local SQLite</p>
        </div>
        <Clock3 size={16} />
      </header>
      <div className="history-list">
        {history.length === 0 && <p className="empty-note">No agent runs yet.</p>}
        {history.map((run) => (
          <article key={run.id}>
            <span>
              <strong>{run.cliId}</strong>
              <small>{new Date(run.startedAt).toLocaleString()}</small>
            </span>
            <p>{run.prompt}</p>
            <em className={`history-status ${run.status}`}>{run.status}</em>
          </article>
        ))}
      </div>
    </section>
  );
}

