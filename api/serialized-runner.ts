export function createSerializedRunner() {
  let tail = Promise.resolve();
  return function runSerialized<T>(operation: () => Promise<T>) {
    const result = tail.then(operation);
    tail = result.then(
      () => {},
      () => {},
    );
    return result;
  };
}
