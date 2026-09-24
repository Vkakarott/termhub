// The app-wide api singleton wires the chat socket's foreground signal to `socketWake`, which
// `_layout.tsx` (AppState `active`) and the session store (entering `unlocked`) emit.
it('passes socketWake as the chat socket foreground signal', () => {
  jest.isolateModules(() => {
    const client = require('./client') as typeof import('./client');
    const { socketWake } = require('./wake') as typeof import('./wake');
    const create = jest.spyOn(client, 'createHttpMobileApi');
    require('./index');
    expect(create).toHaveBeenCalledTimes(1);
    expect(create.mock.calls[0]![0].foreground?.subscribe).toBe(socketWake.subscribe);
    create.mockRestore();
  });
});
