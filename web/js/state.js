/** Shared client state. Small enough that it doesn't need a store library. */
export const state = {
  user: null,
  features: { nova: false, transcode: false },
};
