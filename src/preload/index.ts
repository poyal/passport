import { contextBridge, ipcRenderer, webUtils } from "electron";
import type {
  AppEvent,
  Calls,
  Call,
  PassportAPI,
  Result,
} from "../shared/model";
const names: Call[] = [
  "share.state",
  "share.dismissError",
  "share.unlock",
  "share.reset",
  "share.configure",
  "share.invite",
  "share.join",
  "share.pair",
  "share.peer",
  "share.send",
  "share.approve",
  "share.cancel",
  "share.message",
  "share.deleteMessage",
  "share.openAttachment",
  "share.folder",
  "share.file",
  "control.reply",
  "terminal.create",
  "window.create",
  "window.keyboardContext",
  "terminal.folder",
  "terminal.link",
  "terminal.drop",
  "terminal.preview",
  "activity.list",
  "activity.read",
  "activity.open",
  "activity.clear",
  "activity.focus",
  "activity.test",
  "activity.settings",
  "bootstrap",
  "updates.check",
  "updates.open",
  "save",
  "auth.save",
  "auth.delete",
  "key.pick",
  "session.connect",
  "resume.reply",
  "session.execute",
  "session.broadcast",
  "command.suggest",
  "local.shells",
  "tunnel.start",
  "tunnel.stop",
  "logs.list",
  "logs.groups",
  "logs.readGroup",
  "logs.exportGroup",
  "logs.deleteGroup",
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
  "session.paste",
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
  "clipboard.terminal",
  "clipboard.write",
  "external.open",
];
const api: PassportAPI = {
  async prepareTerminalDrop({ id, files, sessionInstanceId }) {
    if (!Array.isArray(files) || !files.length || files.length > 1000)
      throw new Error("드롭할 파일·폴더는 1~1,000개를 선택하세요.");
    const paths = files.map((file) => webUtils.getPathForFile(file));
    if (paths.some((file) => !file))
      throw new Error(
        "실제 파일 경로가 없는 항목입니다. 파일로 저장한 뒤 드롭하세요.",
      );
    return api.call("terminal.drop", { id, paths, sessionInstanceId });
  },
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
