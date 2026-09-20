"use client";

import {
  Accessibility,
  type DragEndEvent,
  type DragMoveEvent,
  type DragOverEvent,
  type DragStartEvent,
  PointerSensor,
  StyleInjector,
} from "@dnd-kit/dom";
import { DragDropProvider, useDraggable, useDroppable } from "@dnd-kit/react";
import type { TaskCollection, TaskNode } from "@symplist/contracts";
import {
  createContext,
  type ReactNode,
  useCallback,
  useContext,
  useEffect,
  useMemo,
  useRef,
  useState,
} from "react";
import { railItemSelector } from "@/components/shell/workspace";
import { collectionLabels, quoted } from "./commands.ts";
import { type DropEdge, dropPlacement } from "./tree.ts";
import { useWorkspace } from "./workspace-provider.tsx";

const TASK_TYPE = "task";

function rowDroppableId(taskId: string): string {
  return `row:${taskId}`;
}

function railDroppableId(collection: TaskCollection): string {
  return `rail:${collection}`;
}

export interface RowDropState {
  readonly taskId: string;
  readonly edge: DropEdge;
}

interface DragState {
  readonly draggingId: string | null;
  readonly row: RowDropState | null;
  readonly rail: TaskCollection | null;
}

const DragStateContext = createContext<DragState>({ draggingId: null, row: null, rail: null });

/** The current drag, for rows that draw the insertion cue and for the rail destinations. */
export function useTaskDragState(): DragState {
  return useContext(DragStateContext);
}

function elementOf(target: unknown): Element | null {
  const element = (target as { element?: unknown } | null)?.element;
  return element instanceof Element ? element : null;
}

/** The page's CSP nonce, so the drag library's injected stylesheet is allowed (§10.4, decision W1). */
function pageNonce(doc: Document | undefined = globalThis.document): string | undefined {
  const script = doc?.querySelector<HTMLScriptElement>("script[nonce]");
  return script?.nonce || undefined;
}

export interface TaskDragProviderProps {
  readonly collection: TaskCollection;
  readonly children: ReactNode;
}

/**
 * Pointer drag and drop for the task list (workspace_later.md): drop a row on another row to place it
 * there, or on a rail collection to move it with its subtasks. The keyboard and touch path is the
 * Move to… menu, which does the same thing through the same command.
 */
export function TaskDragProvider({ collection, children }: TaskDragProviderProps) {
  const { tasks, commands } = useWorkspace();
  const [state, setState] = useState<DragState>({ draggingId: null, row: null, rail: null });
  const stateRef = useRef(state);
  stateRef.current = state;
  const nonce = useMemo(() => pageNonce(), []);

  const titleOf = useCallback(
    (taskId: string | null) => (taskId ? (tasks.findLoaded(taskId)?.title ?? "task") : "task"),
    [tasks],
  );

  const track = useCallback((event: DragOverEvent | DragMoveEvent) => {
    const source = event.operation.source;
    const target = event.operation.target;
    const draggingId = typeof source?.data?.taskId === "string" ? source.data.taskId : null;
    if (!target) {
      setState((current) => ({ ...current, draggingId, row: null, rail: null }));
      return;
    }
    const collectionTarget = target.data?.collection as TaskCollection | undefined;
    if (collectionTarget) {
      setState({ draggingId, row: null, rail: collectionTarget });
      return;
    }
    const taskId = typeof target.data?.taskId === "string" ? target.data.taskId : null;
    const element = elementOf(target);
    if (!taskId || !element) {
      setState((current) => ({ ...current, draggingId, row: null, rail: null }));
      return;
    }
    const rect = element.getBoundingClientRect();
    const pointer = event.operation.position.current.y;
    const edge: DropEdge = pointer < rect.top + rect.height / 2 ? "before" : "after";
    setState({ draggingId, row: { taskId, edge }, rail: null });
  }, []);

  const onDragEnd = useCallback(
    (event: DragEndEvent) => {
      const { row, rail, draggingId } = stateRef.current;
      setState({ draggingId: null, row: null, rail: null });
      const sourceId =
        typeof event.operation.source?.data?.taskId === "string"
          ? event.operation.source.data.taskId
          : draggingId;
      if (event.canceled || !sourceId) return;
      if (rail && rail !== collection) {
        void commands.moveToCollection(sourceId, rail);
        return;
      }
      if (!row || row.taskId === sourceId) return;
      const placement = dropPlacement(
        tasks.collection(collection).tasks,
        sourceId,
        row.taskId,
        row.edge,
      );
      if (!placement) return;
      void commands.move(
        sourceId,
        placement.request,
        placement.insert,
        `${row.edge} ${quoted(titleOf(row.taskId))}`,
      );
    },
    [collection, commands, tasks, titleOf],
  );

  const announcements = useMemo(
    () => ({
      dragstart: (event: DragStartEvent) =>
        `Picked up ${quoted(titleOf((event.operation.source?.data?.taskId as string) ?? null))}. Drop it on a task to place it there, or on Now, Later or Unclassified to move it.`,
      dragover: (event: DragOverEvent) => {
        const target = event.operation.target;
        if (!target) return undefined;
        const destination = target.data?.collection as TaskCollection | undefined;
        if (destination) return `Move to ${collectionLabels[destination]}`;
        const taskId = typeof target.data?.taskId === "string" ? target.data.taskId : null;
        const row = stateRef.current.row;
        if (!taskId || !row) return undefined;
        return `${row.edge === "before" ? "Before" : "After"} ${quoted(titleOf(taskId))}`;
      },
      dragend: (event: DragEndEvent) =>
        event.canceled
          ? "Cancelled. Nothing moved."
          : `Dropped ${quoted(titleOf((event.operation.source?.data?.taskId as string) ?? null))}`,
    }),
    [titleOf],
  );

  return (
    <DragDropProvider
      plugins={(defaults) => [
        ...defaults,
        StyleInjector.configure(nonce ? { nonce } : {}),
        Accessibility.configure({
          announcements,
          screenReaderInstructions: {
            draggable:
              "Drag a task onto another task to place it there, or onto Now, Later or Unclassified to move it. Without a pointer, use the task menu's Move to… instead.",
          },
        }),
      ]}
      // Pointer only: dragging starts from a row's grip, and the keyboard and touch path is the
      // Move to… menu (workspace_later.md), so no key press is ever captured by a drag.
      sensors={() => [PointerSensor]}
      onDragStart={(event: DragStartEvent) => {
        const taskId = event.operation.source?.data?.taskId;
        setState({
          draggingId: typeof taskId === "string" ? taskId : null,
          row: null,
          rail: null,
        });
      }}
      onDragOver={track}
      onDragMove={track}
      onDragEnd={onDragEnd}
    >
      <DragStateContext.Provider value={state}>
        {children}
        <RailDropTargets collection={collection} />
      </DragStateContext.Provider>
    </DragDropProvider>
  );
}

/**
 * Registers a task row as a drop position and its grip as the drag source. The grip is the drag
 * handle, so a click still selects the task and the row keeps its `treeitem` semantics.
 */
export function useTaskRowDrag(task: TaskNode, disabled: boolean) {
  const draggable = useDraggable({
    id: `task:${task.id}`,
    type: TASK_TYPE,
    data: { taskId: task.id },
    disabled,
  });
  const droppable = useDroppable({
    id: rowDroppableId(task.id),
    type: TASK_TYPE,
    accept: TASK_TYPE,
    data: { taskId: task.id },
    disabled,
  });
  const dragRef = draggable.ref;
  const dropRef = droppable.ref;
  const setRef = useCallback(
    (element: Element | null) => {
      dragRef(element);
      dropRef(element);
    },
    [dragRef, dropRef],
  );
  return { ref: setRef, handleRef: draggable.handleRef, isDragSource: draggable.isDragSource };
}

/** The rail's collection destinations, registered on the shell's own rail elements. */
function RailDropTargets({ collection }: { readonly collection: TaskCollection }) {
  const others = (["now", "later", "unclassified"] as const).filter(
    (candidate) => candidate !== collection,
  );
  return (
    <>
      {others.map((destination) => (
        <RailDropTarget key={destination} collection={destination} />
      ))}
    </>
  );
}

function RailDropTarget({ collection }: { readonly collection: TaskCollection }) {
  const [element, setElement] = useState<Element | null>(null);
  const [rect, setRect] = useState<DOMRect | null>(null);
  const { draggingId } = useTaskDragState();
  useEffect(() => {
    setElement(document.querySelector(railItemSelector(collection)));
  }, [collection]);
  const { isDropTarget } = useDroppable({
    id: railDroppableId(collection),
    type: "collection",
    accept: TASK_TYPE,
    data: { collection },
    ...(element ? { element } : {}),
    disabled: element === null,
  });

  /**
   * The label is positioned in viewport coordinates, so its anchor has to be re-read while it is
   * shown: a rect taken once at render stays behind when the page scrolls or the window resizes.
   */
  useEffect(() => {
    if (!isDropTarget || !(element instanceof HTMLElement)) {
      setRect(null);
      return;
    }
    const measure = () => setRect(element.getBoundingClientRect());
    measure();
    window.addEventListener("scroll", measure, { passive: true, capture: true });
    window.addEventListener("resize", measure, { passive: true });
    return () => {
      window.removeEventListener("scroll", measure, { capture: true });
      window.removeEventListener("resize", measure);
    };
  }, [element, isDropTarget]);

  // The destination is named and outlined, never marked by color alone (workspace_later.md).
  useEffect(() => {
    if (!(element instanceof HTMLElement)) return;
    if (isDropTarget) element.dataset.dropTarget = "true";
    else delete element.dataset.dropTarget;
    return () => {
      delete element.dataset.dropTarget;
    };
  }, [element, isDropTarget]);

  if (!isDropTarget || !draggingId || !(element instanceof HTMLElement) || !rect) return null;
  return (
    // The label is the visible half of what the drag layer announces: the `Accessibility` plugin
    // already says "Move to <collection>" on `dragover`, and a live region here would have a screen
    // reader read the same destination twice.
    <div
      aria-hidden="true"
      className="sym-drop-label"
      style={{ top: `${rect.top + rect.height / 2}px`, left: `${rect.right + 8}px` }}
    >
      {`Move to ${collectionLabels[collection]}`}
    </div>
  );
}
