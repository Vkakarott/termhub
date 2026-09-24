import { ChatPanel } from '../components/chat/ChatPanel';

/** The account-wide concierge chat (`/chat`): questions that cross projects, and where the host is chosen. */
export function ChatPage() {
  return <ChatPanel projectId={null} />;
}
