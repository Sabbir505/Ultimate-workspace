import { setUseChatSession, getUseChatSession } from './featureFlags';

test('defaults to true (cursor-style chat is the new default)', async () => {
  expect(await getUseChatSession()).toBe(true);
});

test('round-trips a value', async () => {
  await setUseChatSession(false);
  expect(await getUseChatSession()).toBe(false);
  await setUseChatSession(true);
  expect(await getUseChatSession()).toBe(true);
});