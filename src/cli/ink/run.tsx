import { render } from "ink";
import { App, type AppProps } from "./App.js";

export interface InkHandle {
  waitUntilExit: () => Promise<void>;
  unmount: () => void;
}

/** Mount the Ink agent UI and return a handle to await/unmount it. */
export function mountApp(props: AppProps): InkHandle {
  const instance = render(<App {...props} />, {
    // We manage exit ourselves (exit/quit, Ctrl-C) so Ink's default Ctrl-C
    // handling doesn't race with our quit path.
    exitOnCtrlC: false,
  });
  return {
    waitUntilExit: async () => {
      await instance.waitUntilExit();
    },
    unmount: () => instance.unmount(),
  };
}
