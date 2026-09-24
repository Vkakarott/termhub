import { Text, View } from 'react-native';
import Markdown from 'react-native-markdown-display';
import { tokens } from '@/theme/tokens';
import { AppText, useSchemeName } from '@/ui';
import { failureSentence } from '../model/copy';
import type { LiveFold } from '../model/live';
import type { ChatMessage } from '../model/types';

/** One row of the thread: the person's text as typed, the assistant's rendered as markdown — its
 * final text, or the deltas streamed so far, or "pensando…" while its run shows signs of life. An
 * empty row that never started reads as the failure it is, same as the web. */
export function MessageBubble({ message, fold }: { message: ChatMessage; fold: LiveFold }) {
  const scheme = useSchemeName();

  if (message.role === 'user') {
    return (
      <View className="max-w-[85%] self-end rounded-2xl bg-app-accent px-4 py-2.5">
        <Text className="text-base text-white">{message.text}</Text>
      </View>
    );
  }

  const body = message.text || fold.deltas.get(message.id) || '';
  const palette = tokens[scheme];
  return (
    <View className="max-w-[92%] gap-1 self-start rounded-2xl bg-app-surface px-4 py-2.5">
      {body ? (
        <Markdown
          style={{
            body: { color: palette.text, fontSize: 16 },
            code_inline: { backgroundColor: palette.surface2, color: palette.text },
            fence: { backgroundColor: palette.surface2, color: palette.text, borderColor: palette.border },
            link: { color: palette.accent },
          }}
        >
          {body}
        </Markdown>
      ) : null}
      {message.error_code !== null ? (
        <Text className="text-sm text-app-danger">{failureSentence(message.error_code)}</Text>
      ) : !body && fold.started.has(message.id) ? (
        <AppText variant="muted">pensando…</AppText>
      ) : !body ? (
        <Text className="text-sm text-app-danger">{failureSentence(null)}</Text>
      ) : null}
    </View>
  );
}
