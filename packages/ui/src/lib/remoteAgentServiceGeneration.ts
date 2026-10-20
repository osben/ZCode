// Renderer-local monotonic generation for the remote workspace service proxy.
// Preallocate at session registration so async consumers can read the same generation by object identity and avoid out-of-order effect switches.
const generations = new WeakMap<object, number>();
let nextGeneration = 1;

export function remoteAgentServiceGeneration(agentService: object): number {
  const existing = generations.get(agentService);
  if (existing !== undefined) return existing;

  const generation = nextGeneration++;
  generations.set(agentService, generation);
  return generation;
}
