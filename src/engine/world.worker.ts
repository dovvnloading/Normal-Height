/// <reference lib="webworker" />
import type { WorldWorkerRequest } from '../hooks/worldProtocol';
import { WorldPreviewSession } from './worldPreviewSession';

const scope = self as unknown as DedicatedWorkerGlobalScope;
const session = new WorldPreviewSession();
scope.onmessage = (event: MessageEvent<WorldWorkerRequest>) => {
  void session.run(event.data, (message, transfer = []) => scope.postMessage(message, transfer));
};
