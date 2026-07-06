import { afterEach } from "bun:test";
import { GlobalRegistrator } from "@happy-dom/global-registrator";

// DOM globals for component tests (harmless for pure server tests).
GlobalRegistrator.register();

// react-dom's act() warning gate — Testing Library drives act internally.
(globalThis as Record<string, unknown>).IS_REACT_ACT_ENVIRONMENT = true;

const { cleanup } = await import("@testing-library/react");
afterEach(cleanup);
