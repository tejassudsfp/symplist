import type { ActionContext, PaneId } from "./types.ts";

/** Marks an editor or composer region: `data-action-context="editor"` or `"composer"`. */
export const ACTION_CONTEXT_ATTRIBUTE = "data-action-context";
/** Marks a workspace pane: `data-pane="inbox" | "page" | "chat"`. */
export const PANE_ATTRIBUTE = "data-pane";
/** Marks a modal or menu layer rendered by the shared primitives. */
export const ACTION_LAYER_ATTRIBUTE = "data-action-layer";

const modalSelector = [
  `[${ACTION_LAYER_ATTRIBUTE}="modal"]`,
  '[role="dialog"][aria-modal="true"]',
  '[role="alertdialog"][aria-modal="true"]',
].join(",");

const menuSelector = [
  `[${ACTION_LAYER_ATTRIBUTE}="menu"]`,
  '[role="menu"]',
  '[role="listbox"]',
].join(",");

const textInputTypes = new Set([
  "",
  "text",
  "search",
  "email",
  "password",
  "tel",
  "url",
  "number",
  "date",
  "datetime-local",
  "month",
  "time",
  "week",
]);

const typingRoles = new Set(["textbox", "searchbox", "combobox", "spinbutton"]);

const activationRoles = new Set([
  "button",
  "link",
  "menuitem",
  "menuitemcheckbox",
  "menuitemradio",
  "option",
  "tab",
  "checkbox",
  "radio",
  "switch",
]);

function asElement(target: EventTarget | null): Element | null {
  if (!target || typeof (target as Node).nodeType !== "number") return null;
  const node = target as Node;
  return node.nodeType === 1 ? (node as Element) : node.parentElement;
}

/**
 * Whether key presses at this target are typing: text inputs, textareas, selects, contenteditable
 * (including the Markdown editor and CodeMirror) and ARIA text roles (note 13).
 */
export function isTypingTarget(target: EventTarget | null): boolean {
  const element = asElement(target);
  if (!element) return false;
  const tag = element.tagName;
  if (tag === "TEXTAREA" || tag === "SELECT") return true;
  if (tag === "INPUT") return textInputTypes.has((element as HTMLInputElement).type.toLowerCase());
  if ((element as HTMLElement).isContentEditable) return true;
  const editable = element.closest("[contenteditable]");
  if (editable && editable.getAttribute("contenteditable") !== "false") return true;
  const role = element.getAttribute("role");
  return role !== null && typingRoles.has(role);
}

/** Whether Enter or Space at this target should activate the control natively. */
export function isActivationTarget(target: EventTarget | null): boolean {
  const element = asElement(target);
  if (!element) return false;
  const tag = element.tagName;
  if (tag === "BUTTON" || tag === "SUMMARY") return true;
  if (tag === "A" && element.hasAttribute("href")) return true;
  if (tag === "INPUT") return !textInputTypes.has((element as HTMLInputElement).type.toLowerCase());
  const role = element.getAttribute("role");
  return role !== null && activationRoles.has(role);
}

export interface FocusDescription {
  /** Active contexts in dispatch precedence order. */
  readonly contexts: readonly ActionContext[];
  readonly pane: PaneId | null;
  readonly typing: boolean;
  readonly activation: boolean;
}

function paneOf(element: Element | null): PaneId | null {
  const pane = element?.closest(`[${PANE_ATTRIBUTE}]`)?.getAttribute(PANE_ATTRIBUTE);
  return pane === "inbox" || pane === "page" || pane === "chat" ? pane : null;
}

/**
 * Derives the active contexts for a key event from the DOM: an open modal blocks everything beneath
 * it, an open menu blocks the page, and otherwise editor or composer, pane and app apply in order.
 */
export function describeFocus(target: EventTarget | null, doc: Document): FocusDescription {
  const element = asElement(target);
  const typing = isTypingTarget(target);
  const activation = isActivationTarget(target);
  const pane = paneOf(element);
  const openModal = doc.querySelector(modalSelector);
  if (openModal) {
    const inMenu = element?.closest(menuSelector);
    const contexts: ActionContext[] =
      inMenu && openModal.contains(inMenu) ? ["menu", "modal"] : ["modal"];
    return { contexts, pane: null, typing, activation };
  }
  if (element?.closest(menuSelector)) {
    return { contexts: ["menu"], pane: null, typing, activation };
  }
  const contexts: ActionContext[] = [];
  const region = element
    ?.closest(`[${ACTION_CONTEXT_ATTRIBUTE}]`)
    ?.getAttribute(ACTION_CONTEXT_ATTRIBUTE);
  if (region === "editor" || region === "composer") contexts.push(region);
  if (pane) contexts.push("pane");
  contexts.push("app");
  return { contexts, pane, typing, activation };
}
