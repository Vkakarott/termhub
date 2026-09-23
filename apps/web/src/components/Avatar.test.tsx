// @vitest-environment jsdom
import { cleanup, render } from '@testing-library/react';
import { afterEach, describe, expect, it } from 'vitest';
import { Avatar } from './Avatar';

afterEach(cleanup);

describe('Avatar', () => {
  it('shows the uppercased initial when there is no picture', () => {
    const { container } = render(<Avatar user={{ name: 'pedro', avatar_url: null }} size={24} />);
    expect(container.textContent).toBe('P');
  });

  it('never shows half an emoji, and keeps joined emoji whole', () => {
    const { container, rerender } = render(<Avatar user={{ name: '😀 Ana', avatar_url: null }} size={24} />);
    expect(container.textContent).toBe('😀');
    rerender(<Avatar user={{ name: '👩‍💻dev', avatar_url: null }} size={24} />);
    expect(container.textContent).toBe('👩‍💻');
  });

  it('shows ? without a user or a name', () => {
    const { container } = render(<Avatar user={null} size={24} />);
    expect(container.textContent).toBe('?');
  });
});
