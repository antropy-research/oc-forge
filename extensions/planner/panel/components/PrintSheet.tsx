// The printed task list (`panel/lib/print.ts` puts it in the print sheet):
// as Google Tasks' Print list has it, the list's title, its open tasks in the
// list's order with subtasks indented, each with its date and time, repeat,
// deadline, star and details, and its completed tasks when Completed is open.
import type { PrintedList, PrintedTask } from '../../src/domain/gtaskPrint.ts';

const PrintedRow = ({ task }: { task: PrintedTask }) => (
  <li class={`print-task depth-${task.depth}${task.completed ? ' is-done' : ''}`} data-task={task.id}>
    <span class="print-check" aria-hidden="true">{task.completed ? '✓' : ''}</span>
    <div class="print-body">
      <div class="print-title">
        {task.title}
        {task.starred && <span class="print-star" aria-label="Starred"> ★</span>}
      </div>
      {(task.due || task.repeat || task.deadline || task.completed || task.list) && (
        <div class="print-chips">
          {task.due && <span class={task.overdue ? 'is-overdue' : ''}>{task.due}</span>}
          {task.repeat && <span>{task.repeat}</span>}
          {task.deadline && <span>⚑ {task.deadline}</span>}
          {task.completed && <span>{task.completed}</span>}
          {task.list && <span>{task.list}</span>}
        </div>
      )}
      {task.notes && <div class="print-notes">{task.notes}</div>}
    </div>
  </li>
);

export const TaskListSheet = ({ sheet }: { sheet: PrintedList }) => {
  const open = sheet.sections.reduce((count, section) => count + section.tasks.length, 0);
  return (
    <article class="print-sheet print-tasks" aria-label={`${sheet.title}, printed`}>
      <header class="print-head">
        <h1>{sheet.title}</h1>
        {sheet.account && <p class="print-meta">{sheet.account}</p>}
      </header>
      {open === 0 && <p class="print-meta">No tasks</p>}
      {sheet.sections.map((section, index) => (
        <section key={section.heading ?? index} class="print-section">
          {section.heading && <h2>{section.heading}</h2>}
          <ol class="print-list">{section.tasks.map((task) => <PrintedRow key={task.id} task={task} />)}</ol>
        </section>
      ))}
      {sheet.completed && sheet.completed.length > 0 && (
        <section class="print-section print-completed">
          <h2>Completed ({sheet.completed.length})</h2>
          <ol class="print-list">{sheet.completed.map((task) => <PrintedRow key={task.id} task={task} />)}</ol>
        </section>
      )}
      {sheet.partial && <p class="print-meta">This list is longer than the Planner reads at once; Google Tasks has the rest.</p>}
    </article>
  );
};
