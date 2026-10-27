import { useRef, useState, type DragEvent } from 'react';
import { CalendarDays, Check, GripVertical, Plus, X } from 'lucide-react';
import { useApp } from './context';
import { dueLabel, todayIso } from './labels';
import { InlineEdit } from './ui';
import type { Id, Todo } from './types';

/** Next steps of a thread: the first open item is the thread's next action. */
export default function Todos({ threadId, autoFocus = false }: { threadId: Id; autoFocus?: boolean }) {
  const { index, run, now, notify } = useApp();
  const todos = index.todosOf.get(threadId) ?? [];
  const open = todos.filter(todo => !todo.done);
  const done = todos.filter(todo => todo.done);
  const [showDone, setShowDone] = useState(false);
  const [text, setText] = useState('');
  const [dragging, setDragging] = useState<Id | null>(null);
  const [dropAt, setDropAt] = useState<Id | null>(null);
  const input = useRef<HTMLInputElement>(null);

  const add = async () => {
    if (!text.trim()) return;
    const change = await run(api => api.createTodo({ threadId, text }));
    if (change) { setText(''); input.current?.focus(); }
  };
  const toggle = async (todo: Todo) => {
    const change = await run(api => api.updateTodo(todo.id, { done: !todo.done }));
    if (change && !todo.done) {
      notify({ text: `已完成：${todo.text}`, action: { label: '撤销', run: () => void run(api => api.updateTodo(todo.id, { done: false })) } });
    }
  };
  const drop = (event: DragEvent, target: Id) => {
    event.preventDefault();
    setDropAt(null);
    const source = dragging;
    setDragging(null);
    if (!source || source === target) return;
    const ids = todos.map(todo => todo.id).filter(id => id !== source);
    ids.splice(ids.indexOf(target), 0, source);
    void run(api => api.reorder('todo', ids));
  };

  return (
    <div className="todos">
      <ul className="todo-list">
        {open.map((todo, position) => (
          <li
            key={todo.id}
            className={`todo ${position === 0 ? 'is-next' : ''} ${dropAt === todo.id ? 'is-drop' : ''} ${dragging === todo.id ? 'is-dragging' : ''}`}
            onDragOver={event => { if (dragging) { event.preventDefault(); setDropAt(todo.id); } }}
            onDragLeave={() => setDropAt(current => current === todo.id ? null : current)}
            onDrop={event => drop(event, todo.id)}
          >
            <span
              className="todo-grip"
              draggable
              onDragStart={event => { setDragging(todo.id); event.dataTransfer.effectAllowed = 'move'; event.dataTransfer.setData('text/plain', todo.text); }}
              onDragEnd={() => { setDragging(null); setDropAt(null); }}
              title="拖动排序"
              aria-hidden="true"
            >
              <GripVertical size={12} />
            </span>
            <button className="todo-check" role="checkbox" aria-checked="false" onClick={() => void toggle(todo)} aria-label={`完成：${todo.text}`} />
            <InlineEdit className="todo-text" label="待办内容" value={todo.text} maxLength={500} onCommit={value => void run(api => api.updateTodo(todo.id, { text: value }))} />
            <DueButton todo={todo} now={now} />
            <button className="icon-btn icon-btn-sm todo-remove" onClick={() => void run(api => api.deleteTodo(todo.id))} aria-label={`删除：${todo.text}`}><X size={12} /></button>
          </li>
        ))}
      </ul>
      <div className="todo-add">
        <Plus size={13} />
        <input
          ref={input}
          value={text}
          autoFocus={autoFocus}
          onChange={event => setText(event.target.value)}
          onKeyDown={event => { if (event.key === 'Enter' && !event.nativeEvent.isComposing) { event.preventDefault(); void add(); } }}
          placeholder="添加下一步"
          aria-label="添加下一步"
          maxLength={500}
        />
      </div>
      {done.length > 0 && (
        <>
          <button className="link-btn todo-done-toggle" onClick={() => setShowDone(!showDone)}>{showDone ? '收起已完成' : `已完成 ${done.length} 条`}</button>
          {showDone && (
            <ul className="todo-list is-done">
              {done.map(todo => (
                <li key={todo.id} className="todo is-done">
                  <span className="todo-grip" />
                  <button className="todo-check is-checked" role="checkbox" aria-checked="true" onClick={() => void toggle(todo)} aria-label={`恢复：${todo.text}`}><Check size={10} strokeWidth={3} /></button>
                  <span className="todo-text">{todo.text}</span>
                  <button className="icon-btn icon-btn-sm todo-remove" onClick={() => void run(api => api.deleteTodo(todo.id))} aria-label={`删除：${todo.text}`}><X size={12} /></button>
                </li>
              ))}
            </ul>
          )}
        </>
      )}
    </div>
  );
}

function DueButton({ todo, now }: { todo: Todo; now: number }) {
  const { run } = useApp();
  const [editing, setEditing] = useState(false);
  if (editing) {
    return (
      <input
        type="date"
        className="due-input"
        autoFocus
        defaultValue={todo.due ?? ''}
        aria-label="截止日期"
        onBlur={event => {
          setEditing(false);
          const value = event.target.value || null;
          if (value !== todo.due) void run(api => api.updateTodo(todo.id, { due: value }));
        }}
        onKeyDown={event => {
          if (event.key === 'Enter') (event.target as HTMLInputElement).blur();
          if (event.key === 'Escape') { event.stopPropagation(); setEditing(false); }
        }}
      />
    );
  }
  const overdue = !!todo.due && todo.due < todayIso(now);
  return (
    <button className={`due-chip ${todo.due ? 'has-date' : ''} ${overdue ? 'is-overdue' : ''}`} onClick={() => setEditing(true)} aria-label={todo.due ? `截止：${todo.due}，点击修改` : '设置截止日期'} title={todo.due ?? '设置截止日期'}>
      {todo.due ? dueLabel(todo.due, now) : <CalendarDays size={12} />}
    </button>
  );
}
