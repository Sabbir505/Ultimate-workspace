import { setUseChatSession, getUseChatSession } from './featureFlags';

test('defaults to false', async () => {
  expect(await getUseChatSession()).toBe(false);
});

test('round-trips a value', async () => {
  await setUseChatSession(true);
  expect(await getUseChatSession()).toBe(true);
  await setUseChatSession(false);
  expect(await getUseChatSession()).toBe(false);
});