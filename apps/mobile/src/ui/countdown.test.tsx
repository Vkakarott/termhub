import { act, render, screen } from '@testing-library/react-native';
import { Countdown } from './countdown';

describe('Countdown', () => {
  afterEach(() => {
    jest.useRealTimers();
  });

  it('renders 00:00 and calls onExpire once immediately when already expired on mount', async () => {
    const onExpire = jest.fn();
    const past = new Date(Date.now() - 1000).toISOString();
    await render(<Countdown until={past} onExpire={onExpire} />);
    expect(screen.getByText('00:00')).toBeTruthy();
    expect(onExpire).toHaveBeenCalledTimes(1);
  });

  it('counts down mm:ss under fake timers and calls onExpire exactly once at zero', async () => {
    jest.useFakeTimers();
    jest.setSystemTime(new Date('2026-01-01T00:00:00.000Z'));
    const onExpire = jest.fn();
    const until = new Date(Date.now() + 3000).toISOString();

    await render(<Countdown until={until} onExpire={onExpire} />);
    expect(screen.getByText('00:03')).toBeTruthy();
    expect(onExpire).not.toHaveBeenCalled();

    await act(async () => {
      await jest.advanceTimersByTimeAsync(1000);
    });
    expect(screen.getByText('00:02')).toBeTruthy();
    expect(onExpire).not.toHaveBeenCalled();

    await act(async () => {
      await jest.advanceTimersByTimeAsync(1000);
    });
    expect(screen.getByText('00:01')).toBeTruthy();
    expect(onExpire).not.toHaveBeenCalled();

    await act(async () => {
      await jest.advanceTimersByTimeAsync(1000);
    });
    expect(screen.getByText('00:00')).toBeTruthy();
    expect(onExpire).toHaveBeenCalledTimes(1);

    // The interval is cleared once expired: further ticks must not call onExpire again.
    await act(async () => {
      await jest.advanceTimersByTimeAsync(3000);
    });
    expect(onExpire).toHaveBeenCalledTimes(1);
  });
});
