import { render, screen } from '@testing-library/react-native';
import { StyleSheet, Text } from 'react-native';
import { Sheet } from './sheet';

describe('Sheet', () => {
  it('centres its panel at 560 pt on a wide window', async () => {
    await render(
      <Sheet open onClose={() => undefined} title="Título">
        <Text>corpo</Text>
      </Sheet>,
    );
    expect(StyleSheet.flatten(screen.getByTestId('sheet-panel').props.style)).toMatchObject({ width: '100%', maxWidth: 560, alignSelf: 'center' });
  });
});
