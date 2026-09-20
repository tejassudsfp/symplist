export interface ChatController {
  canSend(): boolean;
  canStop(): boolean;
  send(): Promise<void>;
  stop(): Promise<void>;
}
let current: ChatController | null = null;
export function activeChat() {
  return current;
}
export function registerChat(controller: ChatController) {
  current = controller;
  return () => {
    if (current === controller) current = null;
  };
}
