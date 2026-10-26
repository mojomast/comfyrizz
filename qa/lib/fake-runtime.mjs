// UX20: fake execution adapters that count instead of spend.
//
// The server has three places where paid or long-running work can start: the
// full-pipeline launcher (`pipelineLaunch`), the media backends the run
// controller asks for (`backendFactory`: Google Colab, a bring-your-own
// ComfyUI) and the renderer. Each fake here records the dispatch, never does
// the work, and fails closed: an attempt to start Google Colab or any external
// backend throws, so a regression that reaches it is a failing test rather than
// a surprise bill. Dispatch counts are what acceptance tests assert on.
export class PaidDispatchBlockedError extends Error {
  constructor(what) {
    super(`QA fake runtime refused to dispatch ${what}: acceptance runs never start paid or external work.`);
    this.name = 'PaidDispatchBlockedError';
    this.code = 'QA_PAID_DISPATCH_BLOCKED';
  }
}

export function createFakeRuntime({ cpuBackend = true } = {}) {
  const counters = { pipelineLaunches: [], backendRequests: [], renders: [], cancels: [] };

  /** `pipelineLaunch` for createApp. Records the spec path and returns a cancellable stub worker. */
  const pipelineLaunch = (specPath, onMessage, onExit) => {
    const entry = { specPath, at: new Date().toISOString(), onMessage, onExit };
    counters.pipelineLaunches.push(entry);
    return { cancel() { counters.cancels.push({ specPath }); } };
  };

  /** `backendFactory` for createApp: Google Colab and BYO ComfyUI always refuse. */
  const backendFactory = async (backendId, options = {}) => {
    counters.backendRequests.push({ backendId, packageId: options.packageId ?? null });
    if (backendId === 'cpu' && cpuBackend) return null;
    throw new PaidDispatchBlockedError(`backend "${backendId}"`);
  };

  /** `render` for createApp. A render is a dispatch too; the stub writes a labelled placeholder. */
  const render = async (packagePath, outputPath, options = {}) => {
    counters.renders.push({ packagePath, outputPath, final: Boolean(options.final) });
    throw new PaidDispatchBlockedError('a render');
  };

  return {
    counters,
    pipelineLaunch,
    backendFactory,
    render,
    launches: () => counters.pipelineLaunches.length,
    /** Every dispatch of any kind, for the "zero work started" assertions. */
    totalDispatches: () => counters.pipelineLaunches.length + counters.backendRequests.filter(entry => entry.backendId !== 'cpu').length + counters.renders.length,
    assertNoPaidDispatch() {
      const paid = counters.backendRequests.filter(entry => entry.backendId === 'colab' || entry.backendId === 'byo-comfyui');
      if (paid.length) throw new PaidDispatchBlockedError(`${paid.length} paid backend request(s)`);
    },
  };
}
