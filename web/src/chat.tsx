import { useRef, useState } from 'react';
import { Citations } from './analysis.tsx';
import { errorMessage, post } from './api.ts';
import type { Citation, Selection } from './api.ts';

type Answer = { content: string; citations: Citation[]; insufficient: boolean; partial: boolean; version: string };
type Turn = { id: string; question: string; selected: Selection; answer?: Answer; error?: string };

export function Chat({ selected, draft, setDraft }: { selected: Selection; draft: string; setDraft: (value: string) => void }) {
  const [turns, setTurns] = useState<Turn[]>([]);
  const [pending, setPending] = useState(false);
  const composing = useRef(false);
  const sending = useRef(false);

  async function send(raw: string, retryId?: string) {
    const question = raw.trim();
    if (!question || sending.current) return;
    sending.current = true;
    setPending(true);
    const turn: Turn = { id: retryId ?? crypto.randomUUID(), question, selected };
    if (retryId) setTurns((previous) => previous.map((item) => item.id === retryId ? turn : item));
    else { setTurns((previous) => [...previous, turn]); setDraft(''); }
    const history = turns.filter(({ answer, id }) => answer && id !== turn.id).slice(-5).flatMap((item) => [
      { role: 'user', content: item.question, version: item.selected.version },
      { role: 'assistant', content: item.answer!.content, version: item.selected.version },
    ]);
    try {
      const answer = await post<Answer>('/api/chat', { ...turn.selected, question, history });
      setTurns((previous) => previous.map((item) => item.id === turn.id ? { ...item, answer, error: undefined } : item));
    } catch (error) {
      setTurns((previous) => previous.map((item) => item.id === turn.id ? { ...item, error: errorMessage(error) } : item));
    } finally {
      sending.current = false;
      setPending(false);
    }
  }

  const hasSources = selected.sourceIds.length + selected.libraryIds.length > 0;
  return <>
    {!hasSources && turns.length === 0 && <div className="writing-empty">
      <div className="paper-stack" aria-hidden="true"><span /></div>
      <p>暂无分析和对话</p>
    </div>}
    <section className="work-section chat" aria-label="对话">
      {turns.length > 0 && <div aria-label="对话记录" className="chat-list">
        {turns.map(({ id, question, answer, error }) => <div key={id}>
          <p className="chat-question">{question}</p>
          {answer && <div className="answer"><p>{answer.content}</p><Citations items={answer.citations} />
            {answer.insufficient && <p className="muted">材料不足。</p>}
            {answer.partial && <p className="muted">本次回答使用了部分材料。</p>}
          </div>}
          {error && <div className="row-actions"><p role="alert" className="error">{error}</p>
            <button disabled={pending} onClick={() => void send(question, id)}>重试问答</button></div>}
        </div>)}
      </div>}
      {pending && <p role="status" className="muted">正在回答…</p>}
      {hasSources && <div className="row-actions">
        <button disabled={pending} onClick={() => void send('这些材料的核心结论是什么？')}>这些材料的核心结论是什么？</button>
      </div>}
      <form className="row-actions" onSubmit={(event) => { event.preventDefault(); if (!composing.current) void send(draft); }}>
        <label className="field grow">提问<input value={draft} maxLength={4000} onChange={(event) => setDraft(event.currentTarget.value)}
          onCompositionStart={() => { composing.current = true; }} onCompositionEnd={() => { composing.current = false; }}
          onKeyDown={(event) => {
            if (event.key === 'Enter' && (composing.current || event.nativeEvent.isComposing)) event.preventDefault();
          }} /></label>
        <button type="submit" className="primary" disabled={pending || !draft.trim()}>发送</button>
      </form>
    </section>
  </>;
}
