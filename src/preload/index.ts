import { contextBridge, ipcRenderer } from "electron";
import type {
  AppEvent,
  Calls,
  Call,
  PassportAPI,
  Result,
} from "../shared/model";
const names: Call[] = [
  "bootstrap",
  "updates.check",
  "updates.open",
  "save",
  "auth.save",
  "auth.delete",
  "key.pick",
  "session.connect",
  "session.execute",
  "session.broadcast",
  "command.suggest",
  "local.shells",
  "tunnel.start",
  "tunnel.stop",
  "logs.list",
  "logs.record",
  "logs.read",
  "logs.bookmark",
  "logs.export",
  "logs.delete",
  "theme.import",
  "theme.export",
  "window.move",
  "window.list",
  "window.snapshot",
  "session.close",
  "session.input",
  "session.resize",
  "session.ack",
  "files.connections",
  "files.connect",
  "files.close",
  "files.list",
  "files.action",
  "transfer.add",
  "transfer.cancel",
  "transfer.retry",
  "data.export",
  "data.preview",
  "data.unlock",
  "data.cancel",
  "data.apply",
  "backup.list",
  "backup.preview",
  "clipboard.read",
  "clipboard.write",
  "external.open",
];
const api: PassportAPI = {
  async call<K extends Call>(
    name: K,
    input: Calls[K]["input"],
  ): Promise<Calls[K]["output"]> {
    if (!names.includes(name)) throw new Error("허용되지 않은 요청입니다.");
    const result = (await ipcRenderer.invoke(
      "passport:call",
      name,
      input,
    )) as Result<Calls[K]["output"]>;
    if (!result.ok) throw new Error(result.error);
    return result.value;
  },
  onEvent(listener) {
    const handler = (_event: Electron.IpcRendererEvent, event: AppEvent) =>
      listener(event);
    ipcRenderer.on("passport:event", handler);
    return () => ipcRenderer.removeListener("passport:event", handler);
  },
};
contextBridge.exposeInMainWorld("passport", api);
