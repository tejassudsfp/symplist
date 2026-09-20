"use client";

import type { TaskCollection } from "@symplist/contracts";
import { useCallback, useState } from "react";
import { Button } from "@/components/ui/button";
import { TextField } from "@/features/access/ui/field";
import { Notice } from "@/features/access/ui/notice";
import { useConnectionsEnvironment } from "./api.tsx";
import { useConnectionResource } from "./resource.ts";

export function TaskScope({
  value,
  onChange,
  disabled = false,
}: {
  value: string[] | null;
  onChange: (value: string[] | null) => void;
  disabled?: boolean;
}) {
  return (
    <fieldset className="sym-connection-fields" disabled={disabled}>
      <legend>Task access</legend>
      <label>
        <input
          type="radio"
          name="task-scope"
          checked={value !== null}
          onChange={() => onChange([])}
        />{" "}
        Selected tasks only
      </label>
      <label>
        <input
          type="radio"
          name="task-scope"
          checked={value === null}
          onChange={() => onChange(null)}
        />{" "}
        All current and future tasks
      </label>
      {value === null ? (
        <Notice tone="warning" live="none">
          This agent can reach every task, including tasks you create later. Task creation requires
          this broader scope.
        </Notice>
      ) : (
        <>
          <p className="sym-connection-help">
            Choose up to 100 tasks. Subtasks must be selected individually. The agent cannot create
            tasks outside this selection.
          </p>
          <TaskPicker selected={value} onChange={onChange} />
        </>
      )}
    </fieldset>
  );
}

function TaskPicker({
  selected,
  onChange,
}: {
  selected: string[];
  onChange: (ids: string[]) => void;
}) {
  const [collection, setCollection] = useState<TaskCollection>("now");
  const [query, setQuery] = useState("");
  return (
    <div className="sym-connections">
      <label>
        Collection{" "}
        <select
          aria-label="Task collection"
          value={collection}
          onChange={(event) => setCollection(event.target.value as TaskCollection)}
        >
          <option value="now">Now</option>
          <option value="later">Later</option>
          <option value="unclassified">Unclassified</option>
        </select>
      </label>
      <TextField
        label="Filter loaded tasks"
        value={query}
        onChange={(event) => setQuery(event.target.value)}
      />
      <p className="sym-connection-help" role="status">
        {selected.length} of 100 tasks selected
      </p>
      <TaskChoices
        key={collection}
        collection={collection}
        query={query}
        selected={selected}
        onChange={onChange}
      />
      {selected.length > 0 && <Button onClick={() => onChange([])}>Clear task selection</Button>}
    </div>
  );
}

function TaskChoices({
  collection,
  query,
  selected,
  onChange,
}: {
  collection: TaskCollection;
  query: string;
  selected: string[];
  onChange: (ids: string[]) => void;
}) {
  const { api } = useConnectionsEnvironment();
  const [cursor, setCursor] = useState<string | null>(null);
  const load = useCallback(
    (signal: AbortSignal) => api.tasks(collection, cursor, signal),
    [api, collection, cursor],
  );
  const resource = useConnectionResource(load);
  const matches = (resource.data?.tasks ?? []).filter((task) =>
    task.title.toLowerCase().includes(query.trim().toLowerCase()),
  );
  return (
    <div>
      {resource.loading && <p role="status">Loading tasks…</p>}
      {resource.error && (
        <Notice tone="error" actions={<Button onClick={resource.refresh}>Retry tasks</Button>}>
          {resource.error}
        </Notice>
      )}
      {resource.data && !matches.length && <p>No matching tasks on this page.</p>}
      <ul className="sym-connection-task-choices" aria-label="Tasks to authorize">
        {matches.map((task) => (
          <li key={task.id}>
            <label>
              <input
                type="checkbox"
                checked={selected.includes(task.id)}
                disabled={!selected.includes(task.id) && selected.length >= 100}
                onChange={(event) =>
                  onChange(
                    event.target.checked
                      ? [...selected, task.id]
                      : selected.filter((id) => id !== task.id),
                  )
                }
              />{" "}
              <span>{task.title}</span>
            </label>
          </li>
        ))}
      </ul>
      <div className="sym-connection-row">
        {cursor && <Button onClick={() => setCursor(null)}>First task page</Button>}
        {resource.data?.nextCursor && (
          <Button onClick={() => setCursor(resource.data?.nextCursor ?? null)}>
            Next task page
          </Button>
        )}
      </div>
    </div>
  );
}
