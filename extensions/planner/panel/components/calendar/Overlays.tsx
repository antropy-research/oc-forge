// What opens over the calendar: details popovers, quick create, the event
// editor, and Google Calendar's questions ("Edit recurring event", "Send
// update emails?"). Mounted once by each calendar surface.
import { useEffect, useRef, useState } from 'preact/hooks';
import type { DateKey } from '../../../src/domain/types.ts';
import { calendarUi, useCalendarUi, type Question } from '../../lib/gcal.ts';
import { EventEditor } from './EventEditor.tsx';
import { DayPopover, EventPopover, TaskPopover } from './Popovers.tsx';
import { QuickCreate } from './QuickCreate.tsx';

const QuestionDialog = ({ question }: { question: Question }) => {
  const [choice, setChoice] = useState(question.choices[0]?.id ?? '');
  const ref = useRef<HTMLDivElement>(null);
  useEffect(() => {
    ref.current?.querySelector<HTMLElement>('input, button.primary, button:last-child')?.focus();
    const onKey = (event: KeyboardEvent) => {
      if (event.key !== 'Escape') return;
      event.stopPropagation();
      question.resolve(null);
    };
    document.addEventListener('keydown', onKey, true);
    return () => document.removeEventListener('keydown', onKey, true);
  }, [question]);
  return (
    <div class="modal-backdrop is-top gcal-question-backdrop" onMouseDown={(event) => event.target === event.currentTarget && question.resolve(null)}>
      <div class="gcal-question" role="alertdialog" aria-modal="true" aria-label={question.title} ref={ref}>
        <h2>{question.title}</h2>
        {question.text && <p class="muted">{question.text}</p>}
        {question.style === 'radio' ? (
          <>
            <div role="radiogroup" aria-label={question.title} class="question-choices">
              {question.choices.map((item) => (
                <label key={item.id} class="inline">
                  <input type="radio" name="gcal-question" checked={choice === item.id} onChange={() => setChoice(item.id)} />
                  {item.label}
                </label>
              ))}
            </div>
            <div class="question-actions">
              <button class="link" onClick={() => question.resolve(null)}>Cancel</button>
              <button class="primary" onClick={() => question.resolve(choice)}>OK</button>
            </div>
          </>
        ) : (
          <div class="question-actions">
            {question.choices.map((item, index) => (
              <button key={item.id} class={index === question.choices.length - 1 ? 'primary' : 'link'} onClick={() => question.resolve(item.id === 'cancel' ? null : item.id)}>
                {item.label}
              </button>
            ))}
          </div>
        )}
      </div>
    </div>
  );
};

/** The calendar's popovers, quick create, editor and questions. */
export const CalendarOverlays = ({ onDay }: { onDay?: (date: DateKey) => void }) => {
  const ui = useCalendarUi();
  // Leaving the calendar closes what was open on it.
  useEffect(() => () => calendarUi.set({ popover: null, draft: null, editor: null }), []);
  const popover = ui.popover;
  return (
    <>
      {popover?.kind === 'event' && <EventPopover key={popover.event.id} event={popover.event} anchor={popover.anchor} />}
      {popover?.kind === 'task' && <TaskPopover key={popover.event.id} event={popover.event} anchor={popover.anchor} />}
      {popover?.kind === 'day' && <DayPopover key={popover.date} date={popover.date} events={popover.events} anchor={popover.anchor} onDay={onDay} />}
      {ui.draft && <QuickCreate key={`${ui.draft.anchor.x}:${ui.draft.anchor.y}`} draft={ui.draft} />}
      {ui.editor && <EventEditor key={ui.editor.mode === 'edit' ? ui.editor.event.id : 'new'} target={ui.editor} />}
      {ui.question && <QuestionDialog question={ui.question} />}
    </>
  );
};
