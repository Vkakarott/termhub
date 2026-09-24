import { useLocalSearchParams } from 'expo-router';
import { Placeholder } from '@/ui/placeholder';

/**
 * The conversation (spec §11.2): thread, action cards, composer with dictation, host state lines.
 * `termhub://chat/<conversation_id>` from a push lands here (after the PIN when the app is locked).
 */
export default function ChatScreen() {
  const { id } = useLocalSearchParams<{ id: string }>();
  return <Placeholder title="Conversa" hint={`Conversa ${id ?? ''}: a linha do tempo, os cartões de ação e o compositor com ditado.`} />;
}
