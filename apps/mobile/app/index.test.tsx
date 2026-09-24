import { render, screen } from '@testing-library/react-native';
import StartScreen from './index';

describe('Início', () => {
  it('offers to continue with the e-mail', async () => {
    await render(<StartScreen />);
    expect(screen.getByRole('link', { name: 'Continuar com e-mail' })).toBeTruthy();
  });
});
