import { fireEvent, render, screen } from '@testing-library/react-native';
import { PinPad } from './pin-pad';

describe('PinPad', () => {
  it('reports digits and backspace, and shows the biometrics key only when offered', async () => {
    const onDigit = jest.fn();
    const onBackspace = jest.fn();
    await render(<PinPad onDigit={onDigit} onBackspace={onBackspace} />);
    fireEvent.press(screen.getByRole('button', { name: '7' }));
    fireEvent.press(screen.getByRole('button', { name: 'Apagar' }));
    expect(onDigit).toHaveBeenCalledWith('7');
    expect(onBackspace).toHaveBeenCalledTimes(1);
    expect(screen.queryByRole('button', { name: 'Biometria' })).toBeNull();
  });
});
