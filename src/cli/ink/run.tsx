import { withFullScreen } from "fullscreen-ink";
import { render } from "ink";
import { App, type AppProps } from "./App.js";

export interface InkHandle {
  waitUntilExit: () => Promise<void>;
  unmount: () => void;
}

/**
 * Mount the Ink agent UI and return a handle to await/unmount it.
 *
 * In interactive TTY mode: uses fullscreen-ink to switch to the alternate
 * screen buffer (vim/htop style) so the chat content never leaks into the
 * terminal scrollback, and a fixed layout with inline scroll is possible.
 *
 * In non-interactive / piped mode (CI, one-shot -m flag, stdout redirect):
 * falls back to the classic Ink render() so those flows stay unaffected.
 */
export function mountApp(props: AppProps): InkHandle {
  const isInteractive = process.stdin.isTTY && process.stdout.isTTY;

  if (isInteractive) {
    const fs = withFullScreen(<App {...props} />, {
      // We manage exit ourselves (exit/quit, Ctrl-C) so Ink's default Ctrl-C
      // handling doesn't race with our quit path.
      exitOnCtrlC: false,
    });

    // start() is async but we don't await — the app renders immediately.
    // waitUntilExit() will resolve only after the Ink app exits.
    void fs.start();

    return {
      waitUntilExit: () => fs.waitUntilExit() as Promise<void>,
      unmount: () => {
        // fullscreen-ink restores the terminal automatically on exit via
        // useApp().exit(). Manual unmount is a last-resort safety net.
        fs.instance?.unmount();
      },
    };
  }

  // Non-interactive fallback — plain Ink render (no alternate screen).
  const instance = render(<App {...props} />, { exitOnCtrlC: false });
  return {
    waitUntilExit: () => instance.waitUntilExit() as Promise<void>,
    unmount: () => instance.unmount(),
  };
}
