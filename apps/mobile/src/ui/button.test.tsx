import { fireEvent, render, screen } from '@testing-library/react-native';
import { Button } from './button';

describe('Button', () => {
  it('calls onPress and exposes its label as the accessible name', async () => {
    const onPress = jest.fn();
    await render(<Button label="Continuar" onPress={onPress} />);
    fireEvent.press(screen.getByRole('button', { name: 'Continuar' }));
    expect(onPress).toHaveBeenCalledTimes(1);
  });
  it('does not fire while loading and shows the spinner', async () => {
    const onPress = jest.fn();
    await render(<Button label="Enviar" onPress={onPress} loading />);
    fireEvent.press(screen.getByRole('button', { name: 'Enviar' }));
    expect(onPress).not.toHaveBeenCalled();
    expect(screen.getByTestId('button-spinner')).toBeTruthy();
  });
});
