import type { ReactNode } from 'react';
import { Modal, Pressable, View } from 'react-native';
import { AppText } from './text';

type Props = { open: boolean; onClose(): void; title: string; children: ReactNode };

export function Sheet({ open, onClose, title, children }: Props) {
  return (
    <Modal transparent animationType="slide" visible={open} onRequestClose={onClose}>
      <View className="flex-1 justify-end">
        <Pressable
          className="absolute inset-0 bg-black/50"
          onPress={onClose}
          accessibilityRole="button"
          accessibilityLabel="Fechar"
        />
        <View className="rounded-t-3xl bg-app-surface p-6">
          <AppText variant="title">{title}</AppText>
          <View className="mt-4">{children}</View>
        </View>
      </View>
    </Modal>
  );
}
