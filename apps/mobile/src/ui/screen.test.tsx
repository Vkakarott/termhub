import { render, screen } from '@testing-library/react-native';
import { StyleSheet, Text } from 'react-native';
import { Screen } from './screen';

const column = () => StyleSheet.flatten(screen.getByTestId('screen-column').props.style);

describe('Screen', () => {
  it('centres its content in a readable column by default', async () => {
    await render(<Screen><Text>oi</Text></Screen>);
    expect(column()).toMatchObject({ width: '100%', maxWidth: 720, alignSelf: 'center' });
    expect(screen.getByText('oi')).toBeTruthy();
  });

  it('keeps the readable column when scrolling', async () => {
    await render(<Screen scroll><Text>oi</Text></Screen>);
    expect(column()).toMatchObject({ maxWidth: 720 });
  });

  it('spans the whole window with width="full"', async () => {
    await render(<Screen width="full"><Text>oi</Text></Screen>);
    expect(column().maxWidth).toBeUndefined();
  });
});
