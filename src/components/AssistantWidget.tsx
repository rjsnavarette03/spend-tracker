import { useCallback, useEffect, useRef, useState } from 'react';
import { Link } from 'react-router-dom';
import type { AssistantMessage, AssistantStatus } from '../../shared/types';
import { api } from '../api';
import { replyBlocks } from '../assistantText';
import { cleanError } from '../format';
import { SendIcon, SparkleIcon, TrashIcon, XIcon } from './Icons';

// The floating "Ask about your money" chat: a bubble in the bottom-right
// corner of every signed-in page that opens a chat window (full screen on
// phones). The server answers each question from the user's current data
// (POST /assistant/chat) and keeps nothing, so the conversation lives here, in
// memory per user: it survives moving between pages but not a reload. Nothing
// renders when the server has no AI configured.

const SUGGESTIONS = [
  'How much did I spend this month?',
  'What are my biggest expenses?',
  'Am I over any budget?',
  'How does this month compare to last month?',
];
/** Messages sent with each question (the server reads at most this many). */
const HISTORY_SENT = 10;
const MAX_QUESTION = 500;
/** While a toast or the page's last row would sit under the bubble (see styles.css). */
const BODY_CLASS = 'has-assistant';

const conversations = new Map<number, AssistantMessage[]>();

function ReplyText({ text }: { text: string }) {
  return (
    <>
      {replyBlocks(text).map((b, i) =>
        b.kind === 'p' ? (
          <p key={i}>{b.text}</p>
        ) : b.kind === 'ul' ? (
          <ul key={i}>
            {b.items.map((item, j) => (
              <li key={j}>{item}</li>
            ))}
          </ul>
        ) : (
          <ol key={i}>
            {b.items.map((item, j) => (
              <li key={j}>{item}</li>
            ))}
          </ol>
        )
      )}
    </>
  );
}

export function AssistantWidget({ userId, userName }: { userId: number; userName: string }) {
  const [status, setStatus] = useState<AssistantStatus | null>(null);
  const [open, setOpen] = useState(false);
  const [messages, setMessages] = useState<AssistantMessage[]>(() => conversations.get(userId) ?? []);
  const [input, setInput] = useState('');
  const [sending, setSending] = useState(false);
  const [error, setError] = useState<string | null>(null);
  // An answer that arrived while the window was closed.
  const [unread, setUnread] = useState(false);
  const logRef = useRef<HTMLDivElement>(null);
  const inputRef = useRef<HTMLInputElement>(null);
  const bubbleRef = useRef<HTMLButtonElement>(null);
  const openRef = useRef(open);
  openRef.current = open;

  const close = useCallback(() => {
    setOpen(false);
    bubbleRef.current?.focus();
  }, []);

  useEffect(() => {
    let alive = true;
    api.assistant
      .status()
      .then((s) => alive && setStatus(s))
      // No chat if the status can't be read: it's an extra, never in the way.
      .catch(() => alive && setStatus(null));
    return () => {
      alive = false;
    };
  }, []);

  const enabled = !!status?.enabled;
  useEffect(() => {
    if (!enabled) return;
    document.body.classList.add(BODY_CLASS);
    return () => document.body.classList.remove(BODY_CLASS);
  }, [enabled]);

  useEffect(() => {
    conversations.set(userId, messages);
  }, [userId, messages]);

  useEffect(() => {
    const el = logRef.current;
    if (el) el.scrollTop = el.scrollHeight;
  }, [messages, sending, open]);

  useEffect(() => {
    if (!open) return;
    setUnread(false);
    // On phones the window fills the screen; don't pop the keyboard over it.
    if (window.matchMedia('(min-width: 861px)').matches) inputRef.current?.focus();
    const onKey = (e: KeyboardEvent) => {
      // A dialog opened from the page handles its own Escape.
      if (e.key === 'Escape' && !document.querySelector('.modal-overlay')) close();
    };
    window.addEventListener('keydown', onKey);
    return () => window.removeEventListener('keydown', onKey);
  }, [open, close]);

  if (!status?.enabled) return null;
  const outOfQuestions = status.remaining <= 0;

  async function ask(question: string) {
    const q = question.trim();
    if (!q || sending || outOfQuestions) return;
    const before = messages;
    const next: AssistantMessage[] = [...before, { role: 'user', content: q }];
    setMessages(next);
    setInput('');
    setError(null);
    setSending(true);
    try {
      const r = await api.assistant.chat(next.slice(-HISTORY_SENT));
      setMessages([...next, { role: 'assistant', content: r.reply }]);
      setStatus((s) => (s ? { ...s, remaining: r.remaining } : s));
      if (!openRef.current) setUnread(true);
    } catch (err) {
      // Put the question back in the box so it can be sent again.
      setMessages(before);
      setInput(q);
      setError(cleanError(err));
      if ((err as { status?: number }).status === 429) {
        setStatus((s) => (s ? { ...s, remaining: 0 } : s));
      }
    } finally {
      setSending(false);
    }
  }

  const firstName = userName.trim().split(/\s+/)[0];

  return (
    <>
      {open && (
        <section className="assistant-window" role="dialog" aria-label="Ask about your money">
          <header className="assistant-head">
            <span className="assistant-avatar" aria-hidden="true">
              <SparkleIcon size={17} />
            </span>
            <div className="assistant-head-text">
              <div className="assistant-head-title">Ask about your money</div>
              <div className="assistant-head-sub">AI answers from your data</div>
            </div>
            {messages.length > 0 && (
              <button
                type="button"
                className="btn-icon"
                onClick={() => {
                  setMessages([]);
                  setError(null);
                }}
                disabled={sending}
                title="Clear conversation"
                aria-label="Clear conversation"
              >
                <TrashIcon size={16} />
              </button>
            )}
            <button type="button" className="btn-icon" onClick={close} title="Close" aria-label="Close chat">
              <XIcon size={18} />
            </button>
          </header>

          <div className="assistant-log" ref={logRef} aria-live="polite">
            <div className="assistant-msg bot">
              <p>
                Hi{firstName ? ` ${firstName}` : ''}! Ask me anything about your spending, budgets,
                accounts or bills.
              </p>
            </div>
            {messages.length === 0 && (
              <div className="assistant-suggestions">
                {SUGGESTIONS.map((s) => (
                  <button
                    key={s}
                    type="button"
                    className="assistant-chip"
                    onClick={() => void ask(s)}
                    disabled={sending || outOfQuestions}
                  >
                    {s}
                  </button>
                ))}
              </div>
            )}
            {messages.map((m, i) =>
              m.role === 'user' ? (
                <div key={i} className="assistant-msg user">
                  {m.content}
                </div>
              ) : (
                <div key={i} className="assistant-msg bot">
                  <ReplyText text={m.content} />
                </div>
              )
            )}
            {sending && (
              <div className="assistant-msg bot assistant-thinking" role="status" aria-label="Thinking">
                <span />
                <span />
                <span />
              </div>
            )}
          </div>

          <div className="assistant-bottom">
            {error && (
              <div className="assistant-error" role="alert">
                {error}
              </div>
            )}
            <form
              className="assistant-form"
              onSubmit={(e) => {
                e.preventDefault();
                void ask(input);
              }}
            >
              <input
                ref={inputRef}
                type="text"
                value={input}
                onChange={(e) => setInput(e.target.value)}
                placeholder={outOfQuestions ? 'No questions left today' : 'Ask a question…'}
                maxLength={MAX_QUESTION}
                disabled={outOfQuestions}
                aria-label="Your question"
                enterKeyHint="send"
              />
              <button
                type="submit"
                className="btn btn-primary"
                disabled={sending || outOfQuestions || !input.trim()}
                aria-label="Send question"
                title="Send"
              >
                <SendIcon size={16} />
              </button>
            </form>
            <p className="assistant-foot">
              AI-generated via {status.provider}, so it can be wrong. {status.remaining} of{' '}
              {status.dailyLimit} questions left today.{' '}
              <Link to="/privacy" target="_blank" rel="noopener">
                Privacy
              </Link>
            </p>
          </div>
        </section>
      )}

      <button
        ref={bubbleRef}
        type="button"
        className={`assistant-bubble ${open ? 'is-open' : ''}`}
        onClick={() => (open ? close() : setOpen(true))}
        aria-label={open ? 'Close chat' : 'Ask about your money'}
        aria-expanded={open}
        title={open ? 'Close chat' : 'Ask about your money'}
      >
        {open ? <XIcon size={22} /> : <SparkleIcon size={24} />}
        {unread && !open && <span className="assistant-unread" aria-label="New answer" />}
      </button>
    </>
  );
}
